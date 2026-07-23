/**
 * Pool tests — the drop-in shared world.
 *
 * The game is ONE pool: everyone who connects auto-joins the same world (no
 * lobby/create/ready), gets the shared seed, and sees each other via scene-tagged
 * pose fan-out. These pin the properties that make "pop in and out" work: a
 * shared seed for all, presence broadcast on join/leave/move, distinct colors
 * that repeat past 8, and a pool cap with overflow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lobby } from "../src/realtime/lobby.js";
import { SessionManager } from "../src/realtime/session.js";
import type { Peer } from "../src/realtime/peer.js";
import type { ServerMessage } from "../src/realtime/protocol.js";
import { POOL_MAX } from "../src/realtime/protocol.js";

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
    scene: "tavern",
    ready: false,
    readyAt: 0,
    sessionId: null,
    overflow: false,
  };
}

function setup() {
  return new Lobby(new SessionManager());
}
function typesOf(p: { sent: ServerMessage[] }): string[] {
  return p.sent.map((m) => m.type);
}
function last<T extends ServerMessage["type"]>(p: { sent: ServerMessage[] }, type: T): Extract<ServerMessage, { type: T }> | undefined {
  for (let i = p.sent.length - 1; i >= 0; i--) if (p.sent[i].type === type) return p.sent[i] as Extract<ServerMessage, { type: T }>;
  return undefined;
}

test("joining the pool hands out a color, the shared seed, and a room snapshot", () => {
  const lobby = setup();
  const a = makePeer();
  const b = makePeer();
  lobby.join(a);
  lobby.join(b);

  const wa = last(a, "welcome");
  const wb = last(b, "welcome");
  assert.equal(wa?.slot, 0);
  assert.equal(wb?.slot, 1);
  // Same world for everyone.
  assert.equal(wa?.seed, wb?.seed);
  assert.ok(typeof wa?.seed === "number");
  // a hears b arrive; b's snapshot already holds a.
  assert.ok(typesOf(a).includes("player:join"));
  assert.equal(last(b, "room:state")?.players[0].id, a.id);
});

test("move fans out to others WITH the sender's scene", () => {
  const lobby = setup();
  const a = makePeer();
  const b = makePeer();
  lobby.join(a);
  lobby.join(b);

  lobby.move(a, 3, 4, "E", "dungeon:2");
  const mv = last(b, "player:move");
  assert.equal(mv?.id, a.id);
  assert.equal(mv?.x, 3);
  assert.equal(mv?.scene, "dungeon:2");
});

test("leaving broadcasts player:leave to the pool", () => {
  const lobby = setup();
  const a = makePeer();
  const b = makePeer();
  lobby.join(a);
  lobby.join(b);
  lobby.leave(a);
  assert.equal(last(b, "player:leave")?.id, a.id);
});

test("colors repeat past 8 but every slot stays a valid palette index", () => {
  const lobby = setup();
  const peers = Array.from({ length: 10 }, () => makePeer());
  peers.forEach((p) => lobby.join(p));
  for (const p of peers) {
    const slot = last(p, "welcome")!.slot;
    assert.ok(slot >= 0 && slot < 8, `slot ${slot} in palette range`);
  }
  assert.equal(lobby.roomSize, 10);
});

test("the pool holds POOL_MAX; the next player overflows until a slot frees", () => {
  const lobby = setup();
  const peers = Array.from({ length: POOL_MAX }, () => makePeer());
  peers.forEach((p) => lobby.join(p));
  assert.equal(lobby.roomSize, POOL_MAX);

  const extra = makePeer();
  lobby.join(extra);
  assert.ok(typesOf(extra).includes("room:full"));
  assert.equal(lobby.overflowSize, 1);

  lobby.leave(peers[0]);
  assert.equal(lobby.overflowSize, 0);
  assert.notEqual(last(extra, "welcome")?.slot, -1);
});
