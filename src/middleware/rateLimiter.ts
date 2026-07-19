import { Request, Response, NextFunction } from "express";

interface RateLimitBucket {
  count: number;
  windowStartedAt: number;
}

const ipRequestBuckets = new Map<string, RateLimitBucket>();
const RATE_LIMIT_WINDOW_MILLISECONDS = 60 * 1000;
const MAXIMUM_REQUESTS_ALLOWED = 60;

/**
 * Evict buckets whose window has fully elapsed.
 *
 * This is memory hygiene only — it must never be the thing that resets a
 * caller's allowance. The previous implementation called `ipRequestCounts.clear()`
 * on a single global interval, which made the limit a *global tumbling window*:
 * every IP's counter reset at the same instant regardless of when that IP first
 * appeared. A caller who timed requests around the sweep could land 60 just
 * before it and 60 just after — 120 in quick succession. Each IP now carries its
 * own window start, so the limit is genuinely per-IP.
 *
 * unref() so the sweep timer never keeps the process alive on shutdown.
 */
setInterval(() => {
  const now = Date.now();
  for (const [ipAddress, bucket] of ipRequestBuckets) {
    if (now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MILLISECONDS) {
      ipRequestBuckets.delete(ipAddress);
    }
  }
}, RATE_LIMIT_WINDOW_MILLISECONDS).unref();

/**
 * Identify the caller.
 *
 * `request.ip` is express's own answer and already accounts for the app's
 * `trust proxy` setting: with trust proxy off (the default, and what this
 * service runs with) it is the socket peer address; with a proxy configured it
 * is the correct hop of `x-forwarded-for`.
 *
 * Reading `x-forwarded-for` directly — as this used to — trusts a header the
 * client fully controls. Any caller could send a fresh spoofed value per request
 * and get an unlimited supply of empty buckets, defeating the limiter outright.
 * Do not reintroduce that; change `trust proxy` in server.ts instead.
 */
function resolveClientIdentity(request: Request): string {
  return request.ip || request.socket?.remoteAddress || "unknown";
}

export function rateLimiterMiddleware(request: Request, response: Response, nextFunction: NextFunction): void | Response {
  const clientIpAddress = resolveClientIdentity(request);
  const now = Date.now();

  const existingBucket = ipRequestBuckets.get(clientIpAddress);
  const bucket =
    existingBucket && now - existingBucket.windowStartedAt < RATE_LIMIT_WINDOW_MILLISECONDS
      ? existingBucket
      : { count: 0, windowStartedAt: now };

  if (bucket.count >= MAXIMUM_REQUESTS_ALLOWED) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStartedAt + RATE_LIMIT_WINDOW_MILLISECONDS - now) / 1000)
    );
    response.setHeader?.("Retry-After", String(retryAfterSeconds));
    return response.status(429).json({ error: "Too many requests. Please try again later." });
  }

  bucket.count += 1;
  ipRequestBuckets.set(clientIpAddress, bucket);
  nextFunction();
}

/** Test seam — drops all buckets so cases can start from a clean slate. */
export function __resetRateLimiterForTests(): void {
  ipRequestBuckets.clear();
}
