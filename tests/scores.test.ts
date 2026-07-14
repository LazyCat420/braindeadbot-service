import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";

// db.ts resolves its SQLite path from process.cwd() at import time, so chdir
// into a temp dir before importing anything that touches the database.
const workDir = mkdtempSync(join(tmpdir(), "braindeadbot-scores-test-"));
const originalCwd = process.cwd();
process.chdir(workDir);

const { default: scoresRouter } = await import("../src/routes/scores.js");
const { default: express } = await import("express");

const app = express();
app.use(express.json());
app.use("/api/scores", scoresRouter);

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No ephemeral port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

async function postScore(body: unknown) {
  return fetch(`${baseUrl}/api/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST saves a valid score and returns its id", async () => {
  const response = await postScore({ name: "LazyCat", score: 1200, altitude: 30, meters: 400, tunnelDepth: 12 });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.id);
  assert.equal(data.message, "Score saved!");
});

test("POST floors fractional numeric fields", async () => {
  const response = await postScore({ name: "Frac", score: 99.9, altitude: 1.7, meters: 2.2, tunnelDepth: 3.9 });
  assert.equal(response.status, 200);

  const list = await fetch(`${baseUrl}/api/scores`);
  const { scores } = await list.json();
  const saved = scores.find((s: { name: string }) => s.name === "Frac");
  assert.ok(saved, "expected the Frac score to be in the leaderboard");
  assert.equal(saved.score, 99);
  assert.equal(saved.altitude, 1);
  assert.equal(saved.meters, 2);
  assert.equal(saved.tunnelDepth, 3);
});

test("POST rejects empty and over-long names", async () => {
  assert.equal((await postScore({ name: "", score: 10 })).status, 400);
  assert.equal((await postScore({ name: "ThisNameIsWayTooLong", score: 10 })).status, 400);
  assert.equal((await postScore({ name: 42, score: 10 })).status, 400);
});

test("POST rejects invalid scores", async () => {
  assert.equal((await postScore({ name: "Bad", score: -5 })).status, 400);
  assert.equal((await postScore({ name: "Bad", score: "high" })).status, 400);
  assert.equal((await postScore({ name: "Bad", score: Infinity })).status, 400);
});

test("POST rejects non-numeric altitude/meters/tunnelDepth", async () => {
  assert.equal((await postScore({ name: "Bad", score: 1, altitude: "up" })).status, 400);
  assert.equal((await postScore({ name: "Bad", score: 1, meters: null })).status, 400);
});

test("GET returns top 10 sorted by score descending", async () => {
  for (let i = 0; i < 12; i++) {
    const response = await postScore({ name: `P${i}`, score: i * 100 });
    assert.equal(response.status, 200);
  }

  const list = await fetch(`${baseUrl}/api/scores`);
  assert.equal(list.status, 200);
  const { scores } = await list.json();

  assert.ok(scores.length <= 10, `leaderboard should cap at 10, got ${scores.length}`);
  for (let i = 0; i < scores.length - 1; i++) {
    assert.ok(scores[i].score >= scores[i + 1].score, "scores must be sorted descending");
  }
});
