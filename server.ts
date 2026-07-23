import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { rateLimiterMiddleware } from "./src/middleware/rateLimiter.js";
import scoresRouter from "./src/routes/scores.js";
import youtubeSyncRouter from "./src/routes/youtubeSync.js";
import { attachRealtime } from "./src/realtime/hub.js";

const app = express();

/**
 * Trust proxy — off by default.
 *
 * This governs whether express believes `x-forwarded-for`, and the rate limiter
 * keys on `request.ip`, which express derives from it. The service sits behind
 * no reverse proxy today, so trusting the header would let any caller rotate a
 * spoofed value and reset their own bucket at will. Set TRUST_PROXY (to `1`,
 * `loopback`, a subnet, …) only when a real proxy is actually in front.
 */
if (process.env.TRUST_PROXY) {
  const trustProxySetting = process.env.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(trustProxySetting) ? Number(trustProxySetting) : trustProxySetting);
} else {
  app.set("trust proxy", false);
}

/**
 * CORS — origin allowlist rather than bare `cors()`.
 *
 * `cors()` with no options reflects any Origin and sets
 * `Access-Control-Allow-Origin: *`, so any page on the internet could script a
 * visitor's browser into writing scores. The list is the client's real origins;
 * ALLOWED_ORIGINS (comma-separated) extends it without a code change.
 *
 * Requests with no Origin header (curl, health checks, same-origin server calls)
 * are allowed — CORS is a browser mechanism and blocking them buys nothing.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://room.braindeadbot.com",
  "http://room.braindeadbot.com",
  "http://10.0.0.16:5174",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

const allowedOrigins = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

app.use(
  cors({
    origin(requestOrigin, callback) {
      if (!requestOrigin || allowedOrigins.has(requestOrigin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed: ${requestOrigin}`));
    },
  })
);

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
  // Disallowed CORS origin. Rejected outright rather than merely omitting the
  // response headers — a "simple" cross-origin POST still reaches the handler
  // and writes, even though the browser hides the reply from the attacker.
  if (error && typeof error.message === "string" && error.message.startsWith("Origin not allowed")) {
    response.status(403).json({ error: "Origin not allowed." });
    return;
  }
  console.error("Unhandled error:", error);
  response.status(500).json({ error: "Internal server error." });
});

const PORT = process.env.PORT || 5175;
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// 🕸️ Pinball-Knight multiplayer: attach the raw-ws hub to the same HTTP server
// (path /ws), reusing the REST origin allowlist. Sharing the port keeps
// docker-compose and the deploy untouched.
attachRealtime(server, { allowedOrigins });

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
