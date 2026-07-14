import { Router, Request, Response } from "express";
import { getDb } from "../lib/db.js";
import { getErrorMessage } from "../utils/error-handler.js";
import { ScoreBody } from "../types/index.js";

const router = Router();

router.get("/", (request: Request, response: Response): void => {
  try {
    const database = getDb();
    const scores = database
      .prepare(
        `SELECT id, name, score, altitude, meters, tunnel_depth AS tunnelDepth, created_at AS createdAt
         FROM raccoon_scores
         ORDER BY score DESC
         LIMIT 10`
      )
      .all();
    response.json({ scores });
  } catch (error: unknown) {
    console.error("Failed to fetch scores:", error);
    response.status(500).json({ error: `Failed to fetch scores: ${getErrorMessage(error)}` });
  }
});

router.post("/", (request: Request<{}, {}, ScoreBody>, response: Response): void | Response => {
  try {
    const { name = "???", score = 0, altitude = 0, meters = 0, tunnelDepth = 0 } = request.body;
    
    if (typeof name !== "string" || name.length === 0 || name.length > 12) {
      return response.status(400).json({ error: "Name must be 1-12 characters." });
    }
    if (typeof score !== "number" || score < 0 || isNaN(score) || !isFinite(score)) {
      return response.status(400).json({ error: "Score must be a valid non-negative number." });
    }
    if (
      typeof altitude !== "number" || isNaN(altitude) || !isFinite(altitude) ||
      typeof meters !== "number" || isNaN(meters) || !isFinite(meters) ||
      typeof tunnelDepth !== "number" || isNaN(tunnelDepth) || !isFinite(tunnelDepth)
    ) {
      return response.status(400).json({ error: "Altitude, meters, and tunnelDepth must be valid numbers." });
    }
    
    const database = getDb();
    const statement = database.prepare(
      `INSERT INTO raccoon_scores (name, score, altitude, meters, tunnel_depth)
       VALUES (?, ?, ?, ?, ?)`
    );
    
    const result = statement.run(
      name,
      Math.floor(score),
      Math.floor(altitude),
      Math.floor(meters),
      Math.floor(tunnelDepth)
    );
    
    response.json({ id: result.lastInsertRowid, message: "Score saved!" });
  } catch (error: unknown) {
    console.error("Failed to save score:", error);
    response.status(500).json({ error: `Failed to save score: ${getErrorMessage(error)}` });
  }
});

export default router;
