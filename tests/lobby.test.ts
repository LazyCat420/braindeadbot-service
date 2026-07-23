/**
 * Lobby matchmaking tests.
 *
 * The ready-queue → countdown → party-split logic is the one piece of the
 * realtime layer with real branching, and the one that must never merge two
 * groups into a party of >4 or reshuffle a bystander when someone bails. Driven
 * with a fake clock (manual interval firing) and fake peers (recorded sends),
 * so no socket is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lobby } from "../src/realtime/lobby.js";
import { SessionManager } from "../src/realtime/session.js";
import type { Peer } from "../src/realtime/peer.js";
import type { ServerMessage } from "../src/realtime/protocol.js";

// ── Fake clock: intervals fire only when the test advances time. ──────────────
interface FakeInterval {
  fn: () => void;
  ms: number;
  next: number;
}
class FakeClock {
  t = 0;
  private intervals = new Set<FakeInterval>();
  now(): number {
    return this.t;
  }
  setInterval(fn: () => void, ms: number): NodeJS.Timeout {
    const iv: FakeInterval = { fn, ms, next: this.t + ms };
    this.intervals.add(iv);
    return iv as unknown as NodeJS.Timeout;
  }
  clearInterval(h: NodeJS.Timeout): void {
    this.intervals.delete(h as unknown as FakeInterval);
  }
  /** Advance time in 100ms steps, firing due intervals in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    while (this.t < end) {
      this.t += 100;
      for (const iv of [...this.intervals]) {
        while (this.intervals.has(iv) && iv.next <= this.t) {
          iv.next += iv.ms;
          iv.fn();
        }
      }
    }
  }
}

let nextId = 1;
function makePeer(): Peer & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    id: `p${nextId++}`,
    sent,
    send(m) {
      sent.push(m);
    },
    close() {},
    name: "Knight",
    slot: -1,
    x: 0,
    z: 0,
    facing: "S",
    ready: false,
    readyAt: 0,
    sessionId: null,
    overflow: false,
  };
}

function setup() {
  const clock = new FakeClock();
  const lobby = new Lobby(new SessionManager(), clock);
  return { clock, lobby };
}

function typesOf(p: { sent: ServerMessage[] }): string[] {
  return p.sent.map((m) => m.type);
}
function last<T extends ServerMessage["type"]>(p: { sent: ServerMessage[] }, type: T): Extract<ServerMessage, { type: T }> | undefined {
  for (let i = p.sent.length - 1; i >= 0; i--) if (p.sent[i].type === type) return p.sent[i] as Extract<ServerMessage, { type: T }>;
  return undefined;
}

test("join assigns color slots in order and announces to the room", () => {
  const { lobby } = setup();
  const a = makePeer();
  const b = makePeer();
  lobby.join(a);
  lobby.join(b);

  assert.equal(last(a, "welcome")?.slot, 0);
  assert.equal(last(b, "welcome")?.slot, 1);
  // a was in the room when b joined → a hears player:join for b.
  assert.ok(typesOf(a).includes("player:join"));
  // b's room:state snapshot already contains a.
  const snap = last(b, "room:state");
  assert.equal(snap?.players.length, 1);
  assert.equal(snap?.players[0].id, a.id);
});

test("two ready → 10s countdown → party:start with host = role 0", () => {
  const { clock, lobby } = setup();
  const a = makePeer();
  const b = makePeer();
  lobby.join(a);
  lobby.join(b);

  lobby.setReady(a, true);
  clock.advance(1000); // a alone → solo countdown started
  assert.ok(typesOf(a).includes("solo:countdown"));

  lobby.setReady(b, true); // quorum → party countdown at 10s, solo cancelled
  const forming = last(a, "party:forming");
  assert.equal(forming?.seconds, 10);
  assert.equal(forming?.members.length, 2);

  clock.advance(10_000);
  const startA = last(a, "party:start");
  const startB = last(b, "party:start");
  assert.ok(startA && startB, "both get party:start");
  assert.equal(startA!.sessionId, startB!.sessionId);
  assert.equal(startA!.role, 0);
  assert.equal(startB!.role, 1);
  assert.equal(startA!.hostId, a.id); // role 0 is the host
  assert.equal(startA!.members.length, 2);
});

test("a third ready mid-countdown re-arms to 7s", () => {
  const { clock, lobby } = setup();
  const [a, b, c] = [makePeer(), makePeer(), makePeer()];
  [a, b, c].forEach((p) => lobby.join(p));
  lobby.setReady(a, true);
  lobby.setReady(b, true);
  assert.equal(last(a, "party:forming")?.seconds, 10);
  clock.advance(2000);
  lobby.setReady(c, true);
  assert.equal(last(a, "party:forming")?.seconds, 7); // re-armed, not merged
});

test("one of two ready bails → party:cancelled, remaining drops to solo", () => {
  const { clock, lobby } = setup();
  const a = makePeer();
  const b = makePeer();
  lobby.join(a);
  lobby.join(b);
  lobby.setReady(a, true);
  lobby.setReady(b, true);
  assert.ok(last(a, "party:forming"));

  lobby.setReady(b, false);
  assert.equal(last(a, "party:cancelled")?.reason, "bailed");
  assert.ok(typesOf(a).includes("solo:countdown")); // a alone again
});

test("solo timeout drops the lone knight alone after 30s", () => {
  const { clock, lobby } = setup();
  const a = makePeer();
  lobby.join(a);
  lobby.setReady(a, true);
  clock.advance(1000);
  assert.equal(last(a, "solo:countdown")?.seconds, 29);
  clock.advance(30_000);
  assert.ok(last(a, "solo:start"), "solo:start fires at 0");
});

test("9th knight overflows, then is admitted when a party departs", () => {
  const { clock, lobby } = setup();
  const peers = Array.from({ length: 8 }, () => makePeer());
  peers.forEach((p) => lobby.join(p));
  assert.equal(lobby.roomSize, 8);

  const ninth = makePeer();
  lobby.join(ninth);
  assert.ok(typesOf(ninth).includes("room:full"));
  assert.equal(lobby.overflowSize, 1);

  // First four ready up and depart as a party.
  peers.slice(0, 4).forEach((p) => lobby.setReady(p, true));
  clock.advance(6000); // 4 ready → 5s countdown
  assert.ok(last(peers[0], "party:start"));

  // Room had 8, minus 4 departed = 4, +1 admitted from overflow = 5.
  assert.equal(lobby.roomSize, 5);
  assert.equal(lobby.overflowSize, 0);
  assert.ok(last(ninth, "welcome")?.slot !== -1, "ninth now has a real slot");
});

test("more than 4 ready only sends the first 4; the rest keep queuing", () => {
  const { clock, lobby } = setup();
  const peers = Array.from({ length: 6 }, () => makePeer());
  peers.forEach((p) => lobby.join(p));
  peers.forEach((p) => lobby.setReady(p, true));

  clock.advance(6000); // first party of 4 leaves on the 5s timer
  const first = last(peers[0], "party:start");
  assert.ok(first);
  assert.equal(first!.members.length, 4);
  // Peers 4 and 5 did not join that party.
  assert.equal(last(peers[4], "party:start"), undefined);
  // They now form their own 2-ready countdown.
  assert.equal(last(peers[4], "party:forming")?.seconds, 10);
});
