import express, { Request, Response } from "express";
import cors from "cors";
import { rateLimiterMiddleware } from "./src/middleware/rateLimiter.js";
import scoresRouter from "./src/routes/scores.js";
import youtubeSyncRouter from "./src/routes/youtubeSync.js";

const app = express();
app.use(cors());
app.use(express.json());

// Global rate limiting
app.use(rateLimiterMiddleware);

// Health Endpoint
app.get("/health", (request: Request, response: Response) => {
  response.json({ status: "ok" });
});

// Mounted Routes
app.use("/api/scores", scoresRouter);
app.use("/api/youtube-sync", youtubeSyncRouter);

const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
