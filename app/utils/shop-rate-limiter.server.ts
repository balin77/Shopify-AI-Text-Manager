/**
 * Per-shop in-memory token bucket for the anonymous app-proxy beacons — the
 * same algorithm as `allow404Hit` / `allowWebVitalSample` / `allowReferralHit`,
 * as a factory so a new beacon route does not grow a fourth hand copy.
 *
 * Single-process in memory on purpose (same rationale as those): the app runs
 * one web process, and the limiter only has to stop one shop's storefront
 * from being used to flood the database or the AI key, not to be exact.
 */
export interface ShopRateLimiter {
  /** True (and one token consumed) when allowed; false when drained. */
  allow(shop: string, now?: number): boolean;
  /** Test seam — drops every bucket. */
  reset(): void;
}

const STALE_MS = 60 * 60 * 1000;

export function createShopRateLimiter(opts: { capacity: number; refillPerMin: number }): ShopRateLimiter {
  const buckets = new Map<string, { tokens: number; lastRefillAt: number }>();
  return {
    allow(shop: string, now: number = Date.now()): boolean {
      for (const [key, b] of buckets) {
        if (now - b.lastRefillAt > STALE_MS) buckets.delete(key);
      }
      let bucket = buckets.get(shop);
      if (!bucket) {
        bucket = { tokens: opts.capacity, lastRefillAt: now };
        buckets.set(shop, bucket);
      } else {
        const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
        bucket.tokens = Math.min(opts.capacity, bucket.tokens + (elapsedMs / 60_000) * opts.refillPerMin);
        bucket.lastRefillAt = now;
      }
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}
