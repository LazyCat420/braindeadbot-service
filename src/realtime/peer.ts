/**
 * A connected socket, as the lobby + sessions see it. The transport details
 * (the raw `ws`) live behind `send`, so the matchmaking logic never touches the
 * socket API and stays unit-testable with a fake peer.
 */
import type { Facing, ServerMessage } from "./protocol.js";

export interface Peer {
  readonly id: string;
  /** Serialize + push a frame to this client. No-op if the socket is gone. */
  send(msg: ServerMessage): void;
  /** Close the underlying socket (used on protocol violations). */
  close(code?: number, reason?: string): void;

  // Presence — mutated by the lobby, read when building room snapshots.
  name: string;
  slot: number; // color slot 0..7, or -1 while in overflow
  x: number;
  z: number;
  facing: Facing;
  scene: string; // "tavern" | "dungeon:<floor>" — which world the peer is in
  ready: boolean;
  readyAt: number; // ms timestamp the peer last readied — orders the queue

  /** The dungeon session this peer belongs to, once a party forms. */
  sessionId: string | null;
  /** True while held outside the room waiting for a free slot. */
  overflow: boolean;
}
