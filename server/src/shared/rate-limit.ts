/**
 * Bounded in-memory sliding-window rate limiter. Active buckets are never
 * evicted to admit new keys, so rotating keys cannot reset an existing quota.
 * Global expiry sweeps run on traffic once per second (or once per window for
 * shorter windows); idle storage remains bounded. Each process has its own quotas.
 */

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  /** Maximum distinct active keys; new keys are denied when full. */
  maxBuckets?: number;
  /** Maximum stored hit timestamps across all keys. */
  maxEntries?: number;
}

export interface RateLimiter {
  /** Returns true if allowed, false if over limit or storage is full. */
  take(key: string): boolean;
  /** How many hits can currently be admitted for this key. */
  remaining(key: string): number;
  /** Clear a specific key (e.g. after a successful auth). */
  reset(key: string): void;
}

export function createRateLimiter(
  config: RateLimitConfig,
  clock: () => number = () => performance.now(),
): RateLimiter {
  const maxBuckets = config.maxBuckets ?? 10_000;
  const maxEntries = config.maxEntries ?? 100_000;
  for (const value of [config.windowMs, config.max, maxBuckets, maxEntries]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid rate limit configuration");
  }
  const buckets = new Map<string, number[]>();
  let entries = 0;
  let nextSweep = 0;

  function trim(key: string, now: number): number[] {
    const previous = buckets.get(key) ?? [];
    const live = previous.filter((timestamp) => timestamp > now - config.windowMs);
    entries -= previous.length - live.length;
    if (live.length === 0) buckets.delete(key);
    else buckets.set(key, live);
    return live;
  }

  function sweep(now: number): void {
    if (now < nextSweep) return;
    for (const key of buckets.keys()) trim(key, now);
    nextSweep = now + Math.min(config.windowMs, 1_000);
  }

  return {
    take(key: string): boolean {
      const now = clock();
      sweep(now);
      const hits = trim(key, now);
      if (hits.length >= config.max || entries >= maxEntries) return false;
      if (hits.length === 0 && buckets.size >= maxBuckets) return false;
      hits.push(now);
      entries++;
      buckets.set(key, hits);
      return true;
    },
    remaining(key: string): number {
      const now = clock();
      sweep(now);
      const hits = trim(key, now);
      if (hits.length === 0 && buckets.size >= maxBuckets) return 0;
      return Math.max(0, Math.min(config.max - hits.length, maxEntries - entries));
    },
    reset(key: string): void {
      entries -= buckets.get(key)?.length ?? 0;
      buckets.delete(key);
    },
  };
}
