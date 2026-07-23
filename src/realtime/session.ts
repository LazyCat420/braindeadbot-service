/**
 * 🏰 Dungeon sessions — the host-authoritative relay.
 *
 * A session is a formed party (2–4 knights, or 1 for a solo drop) running one
 * dungeon. Exactly one member is the HOST (role 0); its `session:snapshot`
 * frames are the authoritative world and the server fans them out to the
 * replicas. Replica `session:input` frames go the other way — to the host only.
 *
 * The server does NOT simulate. It enforces one invariant: only the host's
 * snapshots are relayed. That is what makes "one authority owns the physics
 * world" true on the wire even though the sim runs in a browser.
 *
 * Host migration: if the host disconnects mid-run, the lowest-role survivor is
 * promoted so the run doesn't die. The promoted client starts authoring.
 */
import { randomUUID } from "node:crypto";
import type { Peer } from "./peer.js";
import type { PartyMember } from "./protocol.js";

interface Member {
  peer: Peer;
  role: number;
}

export class Session {
  readonly id: string;
  /** Shared floor seed — every member generates identical mazes from it. Sent in
   * party:start/solo:start so all clients agree BEFORE the first floor builds. */
  readonly seed: number;
  private readonly members = new Map<string, Member>();
  private hostId: string;

  private constructor(id: string, seed: number, members: Member[]) {
    this.id = id;
    this.seed = seed;
    this.members = new Map(members.map((m) => [m.peer.id, m]));
    // Role 0 is the host by construction; fall back to the lowest role present.
    this.hostId = members.reduce((a, b) => (b.role < a.role ? b : a)).peer.id;
  }

  static create(peers: Peer[]): Session {
    const id = randomUUID();
    const seed = (Math.random() * 0x7fffffff) | 0;
    const members = peers.map((peer, role) => ({ peer, role }));
    const s = new Session(id, seed, members);
    for (const m of members) m.peer.sessionId = id;
    return s;
  }

  get hostPeerId(): string {
    return this.hostId;
  }
  get size(): number {
    return this.members.size;
  }

  /** Public roster, sorted by role, for `session:state` / `party:start`. */
  roster(): PartyMember[] {
    return [...this.members.values()]
      .sort((a, b) => a.role - b.role)
      .map((m) => ({ id: m.peer.id, slot: m.peer.slot, name: m.peer.name, role: m.role }));
  }

  roleOf(id: string): number {
    return this.members.get(id)?.role ?? -1;
  }

  /** A member (re)announces itself — confirm membership and hand it the roster. */
  hello(peer: Peer): void {
    const m = this.members.get(peer.id);
    if (!m) return; // not part of this session — ignore
    m.peer = peer; // adopt the (possibly reconnected) socket
    peer.send({ type: "session:state", members: this.roster(), hostId: this.hostId, role: m.role, seed: this.seed });
  }

  /** Host → replicas. Dropped (and logged) if a non-host tries to author. */
  relaySnapshot(fromId: string, snap: unknown): void {
    if (fromId !== this.hostId) return; // authority invariant
    for (const m of this.members.values()) {
      if (m.peer.id !== fromId) m.peer.send({ type: "session:snapshot", snap });
    }
  }

  /** Replica → host. */
  relayInput(fromId: string, input: unknown): void {
    if (fromId === this.hostId) return; // the host doesn't send itself input
    const host = this.members.get(this.hostId);
    host?.peer.send({ type: "session:input", fromId, input });
  }

  /** Small reliable game events (boss phase, portal open, …) → everyone else. */
  relayEvent(fromId: string, event: unknown): void {
    for (const m of this.members.values()) {
      if (m.peer.id !== fromId) m.peer.send({ type: "session:event", fromId, event });
    }
  }

  /** Remove a member. Returns true when the session is now empty (delete it). */
  remove(id: string): boolean {
    const m = this.members.get(id);
    if (!m) return this.members.size === 0;
    this.members.delete(id);
    m.peer.sessionId = null;

    if (this.members.size === 0) return true;

    let newHostId: string | undefined;
    if (id === this.hostId) {
      // Promote the lowest-role survivor.
      const next = [...this.members.values()].reduce((a, b) => (b.role < a.role ? b : a));
      this.hostId = next.peer.id;
      newHostId = this.hostId;
    }
    for (const other of this.members.values()) {
      other.peer.send({ type: "session:peer-left", id, newHostId });
    }
    return false;
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  create(peers: Peer[]): Session {
    const s = Session.create(peers);
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Route a member's departure to its session; drop the session if emptied. */
  leave(sessionId: string, peerId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.remove(peerId)) this.sessions.delete(sessionId);
  }
}
