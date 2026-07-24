/**
 * 🕸️ Realtime protocol — a DORMANT copy of the Pinball-Knight wire contract.
 *
 * ⚠️ This hub receives no production traffic: the live pool hub runs IN-PROCESS
 * in the client's own server (`braindeadbot-client/server/realtime.mjs`), which
 * is now the canonical protocol definition together with its browser mirror
 * `braindeadbot-client/src/net/protocol.ts`. The edge routes /ws only to the
 * client. This copy predates the drop-in-pool model and has drifted (no
 * `world`/`act` channel, still has `ready` + the party/session matchmaker);
 * revive it only by re-syncing it against the client files first.
 */

// ── Pool sizing ──────────────────────────────────────────────────────────────
// The game is one shared DROP-IN POOL: everyone who connects joins the same
// world (no lobby/create/ready). POOL_MAX caps concurrent players; colors repeat
// past the 8-color palette.
export const POOL_MAX = 24;
// Legacy lobby/party constants — kept for the (now-dormant) session code paths.
export const TAVERN_MAX = 8;
export const PARTY_MAX = 4;
export const PARTY_MIN = 2;

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

/** The public view of a knight, broadcast to everyone in the pool. */
export interface RemoteKnight {
  id: string;
  slot: number; // color slot 0..7 (repeats past 8)
  name: string;
  x: number;
  z: number;
  facing: Facing;
  ready: boolean;
  /** Which scene the knight is in: "tavern" or "dungeon:<floor>". Renderers only
   * show peers whose scene matches theirs. */
  scene: string;
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
  // Pool presence
  | { type: "hello"; name: string; preferredSlot?: number }
  | { type: "move"; x: number; z: number; facing: Facing; scene: string }
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
  // Identity + pool lifecycle
  | { type: "welcome"; id: string; slot: number; name: string; colors: readonly KnightColor[]; seed: number }
  | { type: "room:state"; players: RemoteKnight[] }
  | { type: "player:join"; player: RemoteKnight }
  | { type: "player:leave"; id: string }
  | { type: "room:full" } // pool at POOL_MAX; caller is held until a slot frees
  // Movement (fanned out from `move`) — carries the sender's current scene
  | { type: "player:move"; id: string; x: number; z: number; facing: Facing; scene: string }
  // Ready gate
  | { type: "player:ready"; id: string; ready: boolean }
  | { type: "party:forming"; members: string[]; seconds: number }
  | { type: "party:tick"; seconds: number }
  | { type: "party:cancelled"; reason: "bailed" | "disconnected" }
  | { type: "party:start"; sessionId: string; members: PartyMember[]; role: number; hostId: string; seed: number }
  // Solo fallback
  | { type: "solo:countdown"; seconds: number }
  | { type: "solo:start"; sessionId: string; seed: number }
  // Dungeon session
  | { type: "session:state"; members: PartyMember[]; hostId: string; role: number; seed: number }
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
