import { Request, Response, NextFunction } from "express";

const ipRequestCounts = new Map<string, number>();
const RATE_LIMIT_WINDOW_MILLISECONDS = 60 * 1000;
const MAXIMUM_REQUESTS_ALLOWED = 60;

setInterval(() => {
  ipRequestCounts.clear();
}, RATE_LIMIT_WINDOW_MILLISECONDS);

export function rateLimiterMiddleware(request: Request, response: Response, nextFunction: NextFunction): void | Response {
  const clientIpAddress = ((request.headers["x-forwarded-for"] as string) || "")
    .split(",")[0].trim() || request.socket.remoteAddress || request.ip || "unknown";
    
  const requestCount = ipRequestCounts.get(clientIpAddress) || 0;
  
  if (requestCount >= MAXIMUM_REQUESTS_ALLOWED) {
    return response.status(429).json({ error: "Too many requests. Please try again later." });
  }
  
  ipRequestCounts.set(clientIpAddress, requestCount + 1);
  nextFunction();
}
