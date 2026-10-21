import { BoundedStore } from "../bounded-store.js";

interface TokenBucketEntry {
  tokens: number;
  lastRefill: number;
  maxRequests: number;
  windowMs: number;
}

export class TokenBucketAlgorithm {
  // Once `windowMs` has elapsed since the last refill, the bucket is guaranteed to have
  // refilled back to `maxRequests` — identical to a fresh key's default state — so the
  // entry can be safely reclaimed.
  private store = new BoundedStore<TokenBucketEntry>(
    (entry, now) => now - entry.lastRefill >= entry.windowMs,
  );

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = this.store.get(key) ?? { tokens: maxRequests, lastRefill: now, maxRequests, windowMs };
    const elapsed = now - bucket.lastRefill;
    const rate = maxRequests / windowMs;
    const newTokens = Math.min(maxRequests, bucket.tokens + elapsed * rate);
    if(newTokens >= 1){
      this.store.set(key, { tokens: newTokens - 1, lastRefill: now, maxRequests, windowMs });
      return true;
    }
    this.store.set(key, { tokens: newTokens, lastRefill: now, maxRequests, windowMs });
    return false;
  }
  getState(key: string, maxRequests: number, windowMs: number) {
    const now = Date.now();
    const bucket = this.store.get(key) ?? { tokens: maxRequests, lastRefill: now, maxRequests, windowMs };
    const elapsed = now - bucket.lastRefill;
    const rate = maxRequests / windowMs;
    const currentTokens = Math.min(maxRequests, bucket.tokens + elapsed * rate);
    return {
      tokensRemaining: parseFloat(currentTokens.toFixed(2)),
      capacity: maxRequests,
    };
  }
}
