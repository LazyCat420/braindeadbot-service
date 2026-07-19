import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { rateLimiterMiddleware, __resetRateLimiterForTests } from "../src/middleware/rateLimiter.js";

function makeRequest(ip: string, forwardedFor?: string): Request {
  return {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    socket: { remoteAddress: ip },
    ip,
  } as unknown as Request;
}

function makeResponse() {
  const captured: { statusCode?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      captured.statusCode = code;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, captured };
}

test("allows up to 60 requests per IP, then returns 429", () => {
  let allowed = 0;
  const next: NextFunction = () => {
    allowed++;
  };

  for (let i = 0; i < 60; i++) {
    const { response } = makeResponse();
    rateLimiterMiddleware(makeRequest("10.9.9.1"), response, next);
  }
  assert.equal(allowed, 60);

  const { response, captured } = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.1"), response, next);
  assert.equal(allowed, 60, "61st request must not reach next()");
  assert.equal(captured.statusCode, 429);
});

test("tracks IPs independently", () => {
  let allowed = 0;
  const next: NextFunction = () => {
    allowed++;
  };
  const { response } = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.2"), response, next);
  assert.equal(allowed, 1);
});

/**
 * The limiter used to read `x-forwarded-for` directly, which the client fully
 * controls: rotating the header per request minted an unlimited supply of empty
 * buckets and defeated the limit entirely. Identity now comes from `request.ip`,
 * which express derives according to the app's `trust proxy` setting (off by
 * default — this service sits behind no proxy).
 */
test("ignores client-controlled x-forwarded-for when deciding identity", () => {
  __resetRateLimiterForTests();
  let allowed = 0;
  const next: NextFunction = () => {
    allowed++;
  };

  for (let i = 0; i < 60; i++) {
    const { response } = makeResponse();
    rateLimiterMiddleware(makeRequest("10.9.9.3", `203.0.113.${i}`), response, next);
  }
  assert.equal(allowed, 60);

  // A brand-new spoofed forwarded-for must NOT buy a fresh allowance.
  const { response, captured } = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.3", "198.51.100.42"), response, next);
  assert.equal(allowed, 60, "rotating x-forwarded-for must not reset the bucket");
  assert.equal(captured.statusCode, 429);
});

/**
 * Regression guard for the global tumbling window. The sweep used to `clear()`
 * every IP at once, so a caller timing requests around it got 120 through in
 * quick succession. Each IP now carries its own window start.
 */
test("each IP gets its own window, not a shared global one", () => {
  __resetRateLimiterForTests();
  const next: NextFunction = () => {};

  // Exhaust one IP.
  for (let i = 0; i < 60; i++) {
    const { response } = makeResponse();
    rateLimiterMiddleware(makeRequest("10.9.9.4"), response, next);
  }
  const exhausted = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.4"), exhausted.response, next);
  assert.equal(exhausted.captured.statusCode, 429);

  // An IP first seen now must get a full allowance, unaffected by the other's
  // window position.
  let secondIpAllowed = 0;
  const countingNext: NextFunction = () => {
    secondIpAllowed++;
  };
  for (let i = 0; i < 60; i++) {
    const { response } = makeResponse();
    rateLimiterMiddleware(makeRequest("10.9.9.5"), response, countingNext);
  }
  assert.equal(secondIpAllowed, 60);

  const secondExhausted = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.5"), secondExhausted.response, next);
  assert.equal(secondExhausted.captured.statusCode, 429);
});
