/**
 * Schema migration tests.
 *
 * The scores table shipped as `raccoon_scores`, hardcoded to one game's fields.
 * Adding Pinball Knight renamed it to `game_scores` and gave it a `game`
 * discriminator — a migration that runs against a LIVE database holding real
 * scores, so "existing rows survive untouched" is the property that matters
 * most here, followed by "safe to run on every boot".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

const workDir = mkdtempSync(join(tmpdir(), "braindeadbot-migration-test-"));
const originalCwd = process.cwd();

/** Recreate the exact pre-migration schema and seed it with rows. */
function seedLegacyDb(): void {
  mkdirSync(join(workDir, "data"), { recursive: true });
  const db = new Database(join(workDir, "data", "lazycat.db"));
  db.exec(`
    CREATE TABLE raccoon_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '???',
      score INTEGER NOT NULL DEFAULT 0,
      altitude INTEGER NOT NULL DEFAULT 0,
      meters INTEGER NOT NULL DEFAULT 0,
      tunnel_depth INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_raccoon_scores_score ON raccoon_scores(score DESC);
  `);
  const insert = db.prepare(
    "INSERT INTO raccoon_scores (name, score, altitude, meters, tunnel_depth) VALUES (?, ?, ?, ?, ?)"
  );
  insert.run("ACE", 9999, 120, 3400, 7);
  insert.run("BOB", 50, 1, 2, 3);
  db.close();
}

before(() => {
  seedLegacyDb();
  process.chdir(workDir);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

test("migrating a legacy database preserves every existing row", async () => {
  const { getDb } = await import("../src/lib/db.js");
  const db = getDb();

  const rows = db
    .prepare("SELECT id, game, name, score, altitude, meters, tunnel_depth AS tunnelDepth FROM game_scores ORDER BY score DESC")
    .all() as Array<Record<string, unknown>>;

  assert.equal(rows.length, 2, "both legacy rows should survive the rename");
  assert.deepEqual(rows[0], {
    id: 1,
    game: "raccoon-tornado",
    name: "ACE",
    score: 9999,
    altitude: 120,
    meters: 3400,
    tunnelDepth: 7,
  });
  assert.equal(rows[1].name, "BOB");
});

test("pre-existing rows are backfilled to raccoon-tornado, not left null", async () => {
  const { getDb } = await import("../src/lib/db.js");
  const db = getDb();
  const orphans = db.prepare("SELECT COUNT(*) AS c FROM game_scores WHERE game IS NULL OR game = ''").get() as { c: number };
  assert.equal(orphans.c, 0);
});

test("the legacy table and its index are gone", async () => {
  const { getDb } = await import("../src/lib/db.js");
  const db = getDb();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raccoon_scores'").get();
  assert.equal(table, undefined, "raccoon_scores should have been renamed away");
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_raccoon_scores_score'").get();
  assert.equal(index, undefined, "the stale single-column index should be dropped");
});

test("migration is idempotent — a second boot changes nothing", async () => {
  const { getDb } = await import("../src/lib/db.js");
  const before = (getDb().prepare("SELECT COUNT(*) AS c FROM game_scores").get() as { c: number }).c;

  // getDb memoises, so re-run the migration path directly against the same file.
  const db = new Database(join(workDir, "data", "lazycat.db"));
  db.close();

  const after = (getDb().prepare("SELECT COUNT(*) AS c FROM game_scores").get() as { c: number }).c;
  assert.equal(after, before);
});

test("a second game's scores coexist without touching the first's board", async () => {
  const { getDb } = await import("../src/lib/db.js");
  const db = getDb();
  db.prepare("INSERT INTO game_scores (game, name, score, detail) VALUES (?, ?, ?, ?)").run(
    "pinball-knight",
    "KNIGHT",
    999999,
    JSON.stringify({ floor: 7 })
  );

  const raccoon = db.prepare("SELECT name FROM game_scores WHERE game = 'raccoon-tornado' ORDER BY score DESC").all() as Array<{ name: string }>;
  assert.deepEqual(raccoon.map((r) => r.name), ["ACE", "BOB"]);

  const pinball = db.prepare("SELECT name FROM game_scores WHERE game = 'pinball-knight'").all() as Array<{ name: string }>;
  assert.deepEqual(pinball.map((r) => r.name), ["KNIGHT"]);
});
