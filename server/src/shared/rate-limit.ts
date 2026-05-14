/**
 * In-memory sliding-window rate limiter. Per-key bucket holds timestamps of
 * recent hits; we trim entries older than the window on every check.
 *
 * Suits single-process BSB; if we scale horizontally later swap in Redis.
 *
 *   const guard = createRateLimiter({ windowMs: 60_000, max: 5 });
 *   if (guard.take(`login:${ip}`)) ... // false = rate-limited
 */

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  /** Returns true if allowed, false if over limit. */
  take(key: string): boolean;
  /** How many hits remain in the current window for this key. */
  remaining(key: string): number;
  /** Clear a specific key (e.g. after a successful auth). */
  reset(key: string): void;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, number[]>();

  function trim(key: string, now: number): number[] {
    const cutoff = now - config.windowMs;
    const arr = buckets.get(key) ?? [];
    const filtered = arr.filter((ts) => ts >= cutoff);
    if (filtered.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, filtered);
    }
    return filtered;
  }

  return {
    take(key: string): boolean {
      const now = Date.now();
      const arr = trim(key, now);
      if (arr.length >= config.max) return false;
      arr.push(now);
      buckets.set(key, arr);
      return true;
    },
    remaining(key: string): number {
      const arr = trim(key, Date.now());
      return Math.max(0, config.max - arr.length);
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
