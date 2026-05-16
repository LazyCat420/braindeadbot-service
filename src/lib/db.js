import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "lazycat.db");

let _db = null;

export function getDb() {
  if (_db) return _db;

  // Ensure data directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Create tables if they don't exist
  _db.exec(`
    CREATE TABLE IF NOT EXISTS raccoon_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '???',
      score INTEGER NOT NULL DEFAULT 0,
      altitude INTEGER NOT NULL DEFAULT 0,
      meters INTEGER NOT NULL DEFAULT 0,
      tunnel_depth INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_raccoon_scores_score
      ON raccoon_scores(score DESC);
  `);

  return _db;
}
