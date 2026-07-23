/**
 * 🍺 The tavern lobby — presence + matchmaking for ONE shared tavern room.
 *
 * Up to TAVERN_MAX (8) knights stand in the room; more are held in an overflow
 * queue and admitted as slots free up. Readying at the notice board joins the
 * READY QUEUE (ordered by ready-time). A countdown runs whose length shrinks as
 * more knights are ready; when it expires the first PARTY_MAX (4) are sliced off
 * into a dungeon Session and the rest keep queuing.
 *
 * The subtlety the whole file exists for: overlapping ready groups must never
 * merge into a party of >4, and one knight bailing must not silently reshuffle
 * someone else into a different party. The countdown is always armed against the
 * *leading* min(4, readyCount) knights, and only re-armed when that count
 * changes — a running countdown is otherwise left to tick.
 */
import {
  COUNTDOWN_BY_READY,
  KNIGHT_COLORS,
  PARTY_MAX,
  PARTY_MIN,
  POOL_MAX,
  SOLO_TIMEOUT_S,
  type Facing,
  type RemoteKnight,
} from "./protocol.js";
import type { Peer } from "./peer.js";
import type { SessionManager } from "./session.js";

/** Injected so the lobby can spin up dungeon sessions without importing the hub. */
type Clock = { now(): number; setInterval(fn: () => void, ms: number): NodeJS.Timeout; clearInterval(t: NodeJS.Timeout): void };

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

export class Lobby {
  private readonly room = new Map<string, Peer>(); // everyone in the pool (≤ POOL_MAX)
  private readonly overflow: Peer[] = []; // waiting for a slot, FIFO
  private readonly usedSlots = new Set<number>();
  // The shared world seed — every player generates the same dungeon from it, so
  // the pool is literally one game. Regenerated when the pool empties so a fresh
  // crowd gets a fresh world.
  private poolSeed = (Math.random() * 0x7fffffff) | 0;

  // Countdown state — at most one runs at a time.
  private countdownTimer: NodeJS.Timeout | null = null;
  private countdownSeconds = 0;
  private countdownForCount = 0; // readyCount the current countdown was armed for
  private soloTimer: NodeJS.Timeout | null = null;
  private soloSeconds = 0;

  constructor(private readonly sessions: SessionManager, private readonly clock: Clock = DEFAULT_CLOCK) {}

  // ── Public roster (for tests / diagnostics) ────────────────────────────────
  get roomSize(): number {
    return this.room.size;
  }
  get overflowSize(): number {
    return this.overflow.length;
  }

  // ── Join / leave ────────────────────────────────────────────────────────────
  join(peer: Peer, preferredSlot?: number): void {
    if (this.room.size >= POOL_MAX) {
      peer.overflow = true;
      peer.slot = -1;
      this.overflow.push(peer);
      peer.send({ type: "room:full" });
      peer.send({ type: "welcome", id: peer.id, slot: -1, name: peer.name, colors: KNIGHT_COLORS, seed: this.poolSeed });
      return;
    }
    this.admit(peer, preferredSlot);
  }

  /** Bring a peer into the pool: assign a color, hand it the world seed, snapshot. */
  private admit(peer: Peer, preferredSlot?: number): void {
    peer.overflow = false;
    peer.slot = this.claimSlot(preferredSlot);
    peer.ready = false;
    this.room.set(peer.id, peer);

    peer.send({ type: "welcome", id: peer.id, slot: peer.slot, name: peer.name, colors: KNIGHT_COLORS, seed: this.poolSeed });
    peer.send({ type: "room:state", players: this.snapshotExcept(peer.id) });
    this.broadcast({ type: "player:join", player: this.view(peer) }, peer.id);
  }

  /** Remove a peer from wherever it is (room, overflow, ready queue). */
  leave(peer: Peer): void {
    const i = this.overflow.indexOf(peer);
    if (i >= 0) this.overflow.splice(i, 1);

    if (this.room.delete(peer.id)) {
      this.releaseSlot(peer.slot);
      this.broadcast({ type: "player:leave", id: peer.id });
      if (peer.ready) {
        peer.ready = false;
        this.onReadyChanged("disconnected");
      }
      this.admitFromOverflow();
      // Empty pool → fresh world for whoever shows up next.
      if (this.room.size === 0 && this.overflow.length === 0) this.poolSeed = (Math.random() * 0x7fffffff) | 0;
    }
  }

  // ── Movement fan-out ─────────────────────────────────────────────────────────
  move(peer: Peer, x: number, z: number, facing: Facing, scene: string): void {
    if (!this.room.has(peer.id)) return;
    peer.x = x;
    peer.z = z;
    peer.facing = facing;
    peer.scene = scene;
    this.broadcast({ type: "player:move", id: peer.id, x, z, facing, scene }, peer.id);
  }

  // ── Ready gate ───────────────────────────────────────────────────────────────
  setReady(peer: Peer, ready: boolean): void {
    if (!this.room.has(peer.id) || peer.ready === ready) return;
    peer.ready = ready;
    peer.readyAt = ready ? this.clock.now() : 0;
    this.broadcast({ type: "player:ready", id: peer.id, ready });
    this.onReadyChanged(ready ? undefined : "bailed");
  }

  /** The ready queue: readied knights, oldest-ready first. */
  private readyQueue(): Peer[] {
    return [...this.room.values()].filter((p) => p.ready).sort((a, b) => a.readyAt - b.readyAt);
  }

  /**
   * Re-derive the timers from the current ready queue. Called on every ready
   * flip and on a disconnect of a ready peer.
   */
  private onReadyChanged(cancelReason?: "bailed" | "disconnected"): void {
    const q = this.readyQueue();
    const n = q.length;

    if (n === 0) {
      this.cancelCountdown(cancelReason);
      this.cancelSolo();
      return;
    }

    if (n === 1) {
      // A running party countdown just lost its quorum — tell whoever's left.
      this.cancelCountdown(cancelReason);
      this.startSolo(q[0]);
      return;
    }

    // n >= 2 → a party countdown owns the gate; the solo timer is irrelevant.
    this.cancelSolo();
    const partyCount = Math.min(PARTY_MAX, n);
    if (this.countdownForCount !== partyCount) {
      // Ready-count changed → re-arm at the new (shorter/longer) duration.
      this.armCountdown(partyCount, q.slice(0, partyCount).map((p) => p.id));
    }
  }

  // ── Party countdown ──────────────────────────────────────────────────────────
  private armCountdown(partyCount: number, memberIds: string[]): void {
    if (this.countdownTimer) this.clock.clearInterval(this.countdownTimer);
    this.countdownForCount = partyCount;
    this.countdownSeconds = COUNTDOWN_BY_READY[partyCount] ?? COUNTDOWN_BY_READY[PARTY_MAX];
    this.broadcast({ type: "party:forming", members: memberIds, seconds: this.countdownSeconds });
    this.countdownTimer = this.clock.setInterval(() => this.tickCountdown(), 1000);
  }

  private tickCountdown(): void {
    this.countdownSeconds -= 1;
    if (this.countdownSeconds > 0) {
      this.broadcast({ type: "party:tick", seconds: this.countdownSeconds });
      return;
    }
    this.formParty();
  }

  private cancelCountdown(reason?: "bailed" | "disconnected"): void {
    if (!this.countdownTimer) return;
    this.clock.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownForCount = 0;
    this.countdownSeconds = 0;
    if (reason) this.broadcast({ type: "party:cancelled", reason });
  }

  private formParty(): void {
    if (this.countdownTimer) this.clock.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownForCount = 0;

    const q = this.readyQueue();
    if (q.length < PARTY_MIN) {
      // Bailed down to <2 in the same tick — abandon quietly and re-derive.
      this.onReadyChanged();
      return;
    }
    const party = q.slice(0, Math.min(PARTY_MAX, q.length));
    this.launch(party);

    // Whoever's still ready gets a fresh countdown next round.
    this.onReadyChanged();
  }

  // ── Solo fallback ────────────────────────────────────────────────────────────
  private startSolo(peer: Peer): void {
    if (this.soloTimer) return; // already ticking for this lone knight
    this.soloSeconds = SOLO_TIMEOUT_S;
    peer.send({ type: "solo:countdown", seconds: this.soloSeconds });
    this.soloTimer = this.clock.setInterval(() => {
      this.soloSeconds -= 1;
      const q = this.readyQueue();
      if (q.length !== 1) {
        this.cancelSolo();
        return;
      }
      if (this.soloSeconds > 0) {
        q[0].send({ type: "solo:countdown", seconds: this.soloSeconds });
        return;
      }
      this.cancelSolo();
      const solo = q[0];
      const session = this.sessions.create([solo]);
      solo.send({ type: "solo:start", sessionId: session.id, seed: session.seed });
      this.depart([solo]);
    }, 1000);
  }

  private cancelSolo(): void {
    if (!this.soloTimer) return;
    this.clock.clearInterval(this.soloTimer);
    this.soloTimer = null;
    this.soloSeconds = 0;
  }

  // ── Launch a party into a dungeon session ────────────────────────────────────
  private launch(party: Peer[]): void {
    const session = this.sessions.create(party);
    const members = session.roster();
    const hostId = session.hostPeerId;
    for (const p of party) {
      p.send({ type: "party:start", sessionId: session.id, members, role: session.roleOf(p.id), hostId, seed: session.seed });
    }
    this.depart(party);
  }

  /** Pull departed players out of the room and backfill from overflow. */
  private depart(party: Peer[]): void {
    for (const p of party) {
      if (this.room.delete(p.id)) {
        this.releaseSlot(p.slot);
        p.ready = false;
        this.broadcast({ type: "player:leave", id: p.id });
      }
    }
    for (let i = 0; i < party.length; i++) this.admitFromOverflow();
  }

  private admitFromOverflow(): void {
    if (this.room.size >= POOL_MAX) return;
    const next = this.overflow.shift();
    if (next) this.admit(next);
  }

  // ── Color slots ──────────────────────────────────────────────────────────────
  // Prefer a distinct color; once all 8 are taken (pool > 8) colors REPEAT —
  // slot is still a valid palette index, it's just no longer unique.
  private claimSlot(preferred?: number): number {
    if (preferred !== undefined && preferred >= 0 && preferred < KNIGHT_COLORS.length && !this.usedSlots.has(preferred)) {
      this.usedSlots.add(preferred);
      return preferred;
    }
    for (let s = 0; s < KNIGHT_COLORS.length; s++) {
      if (!this.usedSlots.has(s)) {
        this.usedSlots.add(s);
        return s;
      }
    }
    return this.room.size % KNIGHT_COLORS.length; // all colors in use — wrap
  }
  private releaseSlot(slot: number): void {
    // Only release a color if no other peer still holds it (colors can repeat).
    if (slot < 0) return;
    for (const p of this.room.values()) if (p.slot === slot) return;
    this.usedSlots.delete(slot);
  }

  // ── Snapshot helpers ─────────────────────────────────────────────────────────
  private view(p: Peer): RemoteKnight {
    return { id: p.id, slot: p.slot, name: p.name, x: p.x, z: p.z, facing: p.facing, ready: p.ready, scene: p.scene };
  }
  private snapshotExcept(id: string): RemoteKnight[] {
    return [...this.room.values()].filter((p) => p.id !== id).map((p) => this.view(p));
  }
  private broadcast(msg: Parameters<Peer["send"]>[0], exceptId?: string): void {
    for (const p of this.room.values()) if (p.id !== exceptId) p.send(msg);
  }
}
