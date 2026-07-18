import { Router, Request, Response } from "express";
import { getDb } from "../lib/db.js";
import { getErrorMessage } from "../utils/error-handler.js";
import { ScoreBody, GAME_IDS, DEFAULT_GAME, isGameId } from "../types/index.js";

const router = Router();

/**
 * Sanity ceiling on a submitted score. There is no auth on this endpoint, so
 * without a bound a single crafted POST (or a client overflow bug) parks
 * Number.MAX_SAFE_INTEGER at the top of a board permanently.
 */
const MAX_SCORE = 100_000_000;

/** Cap on the JSON blob of per-game extras, so `detail` can't be used as storage. */
const MAX_DETAIL_BYTES = 2000;

router.get("/", (request: Request, response: Response): void | Response => {
  try {
    // Boards are per-game. The parameter defaults to raccoon-tornado so the
    // original client (which predates the parameter) keeps working unchanged.
    const game = typeof request.query.game === "string" ? request.query.game : DEFAULT_GAME;
    if (!isGameId(game)) {
      return response.status(400).json({ error: `Unknown game. Expected one of: ${GAME_IDS.join(", ")}` });
    }

    const database = getDb();
    const scores = database
      .prepare(
        `SELECT id, game, name, score, altitude, meters, tunnel_depth AS tunnelDepth,
                detail, created_at AS createdAt
         FROM game_scores
         WHERE game = ?
         ORDER BY score DESC
         LIMIT 10`
      )
      .all(game);
    response.json({ game, scores });
  } catch (error: unknown) {
    console.error("Failed to fetch scores:", error);
    // Log the detail, return a generic message — the raw error leaks schema
    // and file paths to the caller.
    response.status(500).json({ error: "Failed to fetch scores." });
  }
});

router.post("/", (request: Request<object, object, ScoreBody>, response: Response): void | Response => {
  try {
    const { game = DEFAULT_GAME, name = "???", score = 0, altitude = 0, meters = 0, tunnelDepth = 0, detail } = request.body;

    if (!isGameId(game)) {
      return response.status(400).json({ error: `Unknown game. Expected one of: ${GAME_IDS.join(", ")}` });
    }
    if (typeof name !== "string" || name.length === 0 || name.length > 12) {
      return response.status(400).json({ error: "Name must be 1-12 characters." });
    }
    if (typeof score !== "number" || isNaN(score) || !isFinite(score) || score < 0) {
      return response.status(400).json({ error: "Score must be a valid non-negative number." });
    }
    if (score > MAX_SCORE) {
      return response.status(400).json({ error: `Score must be at most ${MAX_SCORE}.` });
    }
    if (
      typeof altitude !== "number" || isNaN(altitude) || !isFinite(altitude) ||
      typeof meters !== "number" || isNaN(meters) || !isFinite(meters) ||
      typeof tunnelDepth !== "number" || isNaN(tunnelDepth) || !isFinite(tunnelDepth)
    ) {
      return response.status(400).json({ error: "Altitude, meters, and tunnelDepth must be valid numbers." });
    }

    // Per-game extras ride along as JSON so a new game never needs a new column.
    let detailJson: string | null = null;
    if (detail !== undefined && detail !== null) {
      if (typeof detail !== "object") {
        return response.status(400).json({ error: "Detail must be an object." });
      }
      detailJson = JSON.stringify(detail);
      if (detailJson.length > MAX_DETAIL_BYTES) {
        return response.status(400).json({ error: `Detail must be under ${MAX_DETAIL_BYTES} bytes.` });
      }
    }

    const database = getDb();
    const statement = database.prepare(
      `INSERT INTO game_scores (game, name, score, altitude, meters, tunnel_depth, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const result = statement.run(
      game,
      name,
      Math.floor(score),
      Math.floor(altitude),
      Math.floor(meters),
      Math.floor(tunnelDepth),
      detailJson
    );

    response.json({ id: result.lastInsertRowid, game, message: "Score saved!" });
  } catch (error: unknown) {
    console.error("Failed to save score:", error);
    response.status(500).json({ error: "Failed to save score." });
  }
});

export default router;
