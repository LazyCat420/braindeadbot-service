import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "lazycat.db");

let _db: Database.Database | null = null;

/** True if `table` exists in the open database. */
function hasTable(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== undefined;
}

/** True if `table` already has a column named `column`. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Bring an existing database up to the current schema. Every step is guarded so
 * this is safe to run on every boot, on a fresh volume or on the live NAS DB.
 *
 * History: the scores table was originally `raccoon_scores`, hardcoded to
 * raccoon-tornado's fields (altitude/meters/tunnel_depth) with no way to tell
 * one game's rows from another's. Adding a second game (Pinball Knight) needed
 * a discriminator, so the table is renamed and given a `game` column. Existing
 * rows are all raccoon-tornado's by definition, which is exactly what the
 * column default backfills them to.
 */
function migrate(db: Database.Database): void {
  // 1. Rename the legacy table in place, preserving every existing row.
  if (hasTable(db, "raccoon_scores") && !hasTable(db, "game_scores")) {
    db.exec("ALTER TABLE raccoon_scores RENAME TO game_scores");
  }

  // 2. Fresh databases get the current shape directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL DEFAULT 'raccoon-tornado',
      name TEXT NOT NULL DEFAULT '???',
      score INTEGER NOT NULL DEFAULT 0,
      altitude INTEGER NOT NULL DEFAULT 0,
      meters INTEGER NOT NULL DEFAULT 0,
      tunnel_depth INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 3. Columns added after the table first shipped. A renamed legacy table
  //    reaches here without them; the default backfills every existing row.
  if (!hasColumn(db, "game_scores", "game")) {
    db.exec("ALTER TABLE game_scores ADD COLUMN game TEXT NOT NULL DEFAULT 'raccoon-tornado'");
  }
  if (!hasColumn(db, "game_scores", "detail")) {
    // Per-game extras as JSON, so a new game never needs another column.
    db.exec("ALTER TABLE game_scores ADD COLUMN detail TEXT");
  }

  // 4. Leaderboards are always read per-game, so that's what the index covers.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_game_scores_game_score
      ON game_scores(game, score DESC);
    DROP INDEX IF EXISTS idx_raccoon_scores_score;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS youtube_handle_cache (
      handle TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  migrate(_db);

  return _db;
}
