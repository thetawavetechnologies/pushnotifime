/**
 * Token-bucket rate limiter. In-process, single-threaded.
 *
 * Purpose: an agent in a retry loop should not page the user thousands of times.
 * This bucket caps outbound sends per minute regardless of how the agent calls us.
 */

import { McpToolError } from "./errors.js";

export interface RateLimiter {
  consume(): void;
}

export function createRateLimiter(perMinute: number): RateLimiter {
  if (!Number.isFinite(perMinute) || perMinute <= 0) {
    throw new Error(`rate limit must be a positive number, got ${perMinute}`);
  }
  const capacity = perMinute;
  const refillPerMs = perMinute / 60_000;
  let tokens = capacity;
  let lastRefillMs = Date.now();

  function refill(nowMs: number): void {
    const elapsed = nowMs - lastRefillMs;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    lastRefillMs = nowMs;
  }

  return {
    consume(): void {
      const now = Date.now();
      refill(now);
      if (tokens < 1) {
        const deficit = 1 - tokens;
        const waitMs = Math.ceil(deficit / refillPerMs);
        throw new McpToolError(
          "RATE_LIMITED",
          `PushNotifi MCP send rate limit exceeded (${capacity}/min). Retry in ~${Math.ceil(waitMs / 1000)}s.`,
          { retry_after_ms: waitMs, capacity_per_minute: capacity }
        );
      }
      tokens -= 1;
    },
  };
}
