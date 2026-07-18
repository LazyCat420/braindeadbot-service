import express, { Request, Response, NextFunction } from "express";
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

/**
 * Error handler. Without one, a malformed JSON body surfaces express's default
 * HTML stack-trace page — but every client path here expects `{ error: string }`
 * and will fail to parse it. Must stay last, and must keep all four params or
 * express registers it as ordinary middleware.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: Error, request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Malformed JSON body." });
    return;
  }
  console.error("Unhandled error:", error);
  response.status(500).json({ error: "Internal server error." });
});

const PORT = process.env.PORT || 5175;
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Graceful shutdown — Docker sends SIGTERM on container stop; without this
// the process ignores it and gets SIGKILLed after the grace period.
function shutdown(signal: string) {
  console.log(`${signal} received — shutting down`);
  server.close(() => process.exit(0));
  // Force-exit if connections refuse to drain
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
