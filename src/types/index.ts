/**
 * Games allowed to write to the leaderboard. An allowlist rather than a free
 * string so a typo'd id becomes a 400 instead of silently creating an orphan
 * board nobody can read back.
 */
export const GAME_IDS = [
  "raccoon-tornado",
  "pinball-knight",
  "ski-game",
  "pirate-surf",
] as const;

export type GameId = (typeof GAME_IDS)[number];

/** Back-compat: requests that predate the `game` field are raccoon-tornado's. */
export const DEFAULT_GAME: GameId = "raccoon-tornado";

export function isGameId(value: unknown): value is GameId {
  return typeof value === "string" && (GAME_IDS as readonly string[]).includes(value);
}

export interface ScoreBody {
  game?: string;
  name?: string;
  score?: number;
  /** raccoon-tornado only. */
  altitude?: number;
  meters?: number;
  tunnelDepth?: number;
  /** Per-game extras, stored as JSON — how a new game carries its own stats. */
  detail?: Record<string, unknown>;
}

export interface ChannelRequest {
  channelId: string;
  artist?: string;
  maxResults?: number;
}

export interface YouTubeSyncBody {
  channels?: ChannelRequest[];
}

export interface RecordResult {
  type: string;
  id: string;
  title: string;
  artist: string;
}

export interface ResultObj {
  records: RecordResult[];
  syncedAt: string;
  errors?: string[];
}
