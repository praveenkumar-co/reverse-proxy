export class TokenBucketAlgorithm {
  private store = new Map<string, { tokens: number; lastRefill: number }>();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    let bucket = this.store.get(key) ?? { tokens: maxRequests, lastRefill: now };
    const elapsed = now - bucket.lastRefill;
    const rate = maxRequests / windowMs;
    const newTokens = Math.min(maxRequests, bucket.tokens + elapsed * rate);
    if(newTokens >= 1){
      bucket = { tokens: newTokens - 1, lastRefill: now };
      this.store.set(key, bucket);
      return true;
    }
    bucket = { tokens: newTokens, lastRefill: now };
    this.store.set(key, bucket);
    return false;
  }
  getState(key: string, maxRequests: number, windowMs: number) {
    const now = Date.now();
    const bucket = this.store.get(key) ?? { tokens: maxRequests, lastRefill: now };
    const elapsed = now - bucket.lastRefill;
    const rate = maxRequests / windowMs;
    const currentTokens = Math.min(maxRequests, bucket.tokens + elapsed * rate);
    return {
      tokensRemaining: parseFloat(currentTokens.toFixed(2)),
      capacity: maxRequests,
    };
  }
}
