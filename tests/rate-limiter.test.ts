import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { rateLimiterMiddleware } from "../src/middleware/rateLimiter.js";

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

test("uses first hop of x-forwarded-for as the client identity", () => {
  let allowed = 0;
  const next: NextFunction = () => {
    allowed++;
  };

  for (let i = 0; i < 60; i++) {
    const { response } = makeResponse();
    rateLimiterMiddleware(makeRequest("10.9.9.3", "203.0.113.7, 10.0.0.1"), response, next);
  }
  const { response, captured } = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.3", "203.0.113.7, 10.0.0.1"), response, next);
  assert.equal(captured.statusCode, 429);

  // Same socket IP but different forwarded client is a different identity
  const fresh = makeResponse();
  rateLimiterMiddleware(makeRequest("10.9.9.3", "203.0.113.99"), fresh.response, next);
  assert.equal(allowed, 61);
});
