/**
 * 🕸️ Realtime protocol — the wire contract for Pinball-Knight multiplayer.
 *
 * This is the CANONICAL definition. The client mirrors it in
 * `braindeadbot-client/src/net/protocol.ts` (same convention the score/youtube
 * services already use — see that file's header). Keep the two in lockstep:
 * every message here has a twin there, and a change to a payload shape is a
 * change to both files or the two ends silently disagree.
 *
 * Two channels ride one socket, distinguished by the `type` discriminator:
 *   • TAVERN  — presence + matchmaking (the lobby owns this)
 *   • SESSION — a formed party's dungeon run (host-authoritative relay)
 *
 * The server is a MATCHMAKER + RELAY, not the physics authority. Inside a
 * dungeon session exactly one member is the host (role 0); its world snapshots
 * are the truth, and the server refuses `session:snapshot` from anyone else.
 */

// ── Room / party sizing ──────────────────────────────────────────────────────
export const TAVERN_MAX = 8; // how many knights may stand in one tavern at once
export const PARTY_MAX = 4; // max members in a single dungeon session
export const PARTY_MIN = 2; // min ready knights to start a party countdown

/** Countdown seconds by how many are ready at the gate — more ready = faster. */
export const COUNTDOWN_BY_READY: Record<number, number> = { 2: 10, 3: 7, 4: 5 };
/** Alone at the gate this long → drop solo. */
export const SOLO_TIMEOUT_S = 30;

// ── The eight knight colors (join-order slots) ───────────────────────────────
export interface KnightColor {
  slot: number;
  name: string;
  hex: number;
}
export const KNIGHT_COLORS: readonly KnightColor[] = [
  { slot: 0, name: "Crimson", hex: 0xe05050 },
  { slot: 1, name: "Cobalt", hex: 0x5080e0 },
  { slot: 2, name: "Ember", hex: 0xe09030 },
  { slot: 3, name: "Sage", hex: 0x50c878 },
  { slot: 4, name: "Violet", hex: 0xa050e0 },
  { slot: 5, name: "Gold", hex: 0xf0c040 },
  { slot: 6, name: "Frost", hex: 0x70d0e0 },
  { slot: 7, name: "Iron", hex: 0x909090 },
] as const;

export type Facing = "N" | "S" | "E" | "W";

/** The public view of a knight, broadcast to everyone in the room. */
export interface RemoteKnight {
  id: string;
  slot: number; // color slot 0..7
  name: string;
  x: number;
  z: number;
  facing: Facing;
  ready: boolean;
}

/** A party member's identity as handed to the dungeon at party:start. */
export interface PartyMember {
  id: string;
  slot: number;
  name: string;
  role: number; // 0 = host (authority), 1..3 = replicas
}

// ── Client → Server ──────────────────────────────────────────────────────────
export type ClientMessage =
  // Tavern
  | { type: "hello"; name: string; preferredSlot?: number }
  | { type: "move"; x: number; z: number; facing: Facing }
  | { type: "ready"; ready: boolean }
  // Dungeon session
  | { type: "session:hello"; sessionId: string }
  | { type: "session:snapshot"; sessionId: string; snap: unknown } // host only
  | { type: "session:input"; sessionId: string; input: unknown } // replica → host
  | { type: "session:event"; sessionId: string; event: unknown } // small reliable game events
  | { type: "session:leave"; sessionId: string }
  // Keepalive
  | { type: "ping" };

// ── Server → Client ──────────────────────────────────────────────────────────
export type ServerMessage =
  // Identity + room lifecycle
  | { type: "welcome"; id: string; slot: number; name: string; colors: readonly KnightColor[] }
  | { type: "room:state"; players: RemoteKnight[] }
  | { type: "player:join"; player: RemoteKnight }
  | { type: "player:leave"; id: string }
  | { type: "room:full" } // 8 slots taken; caller is held in overflow
  // Movement (fanned out from `move`)
  | { type: "player:move"; id: string; x: number; z: number; facing: Facing }
  // Ready gate
  | { type: "player:ready"; id: string; ready: boolean }
  | { type: "party:forming"; members: string[]; seconds: number }
  | { type: "party:tick"; seconds: number }
  | { type: "party:cancelled"; reason: "bailed" | "disconnected" }
  | { type: "party:start"; sessionId: string; members: PartyMember[]; role: number; hostId: string }
  // Solo fallback
  | { type: "solo:countdown"; seconds: number }
  | { type: "solo:start"; sessionId: string }
  // Dungeon session
  | { type: "session:state"; members: PartyMember[]; hostId: string; role: number }
  | { type: "session:snapshot"; snap: unknown } // relayed host snapshot → replicas
  | { type: "session:input"; fromId: string; input: unknown } // relayed replica input → host
  | { type: "session:event"; fromId: string; event: unknown }
  | { type: "session:peer-left"; id: string; newHostId?: string } // host migration if the host left
  | { type: "session:ended"; reason: string }
  // Keepalive
  | { type: "pong" };

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/** Parse + shallow-validate an inbound client frame. Returns null on garbage. */
export function decodeClient(raw: string): ClientMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof (obj as { type?: unknown }).type !== "string") return null;
  return obj as ClientMessage;
}
