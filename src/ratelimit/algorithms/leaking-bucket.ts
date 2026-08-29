export class LeakingBucketAlgorithm {
  private store = new Map<string, { water: number; lastLeak: number }>();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    let bucket = this.store.get(key) ?? { water: 0, lastLeak: now };
    const elapsed = now - bucket.lastLeak;
    const leaked = elapsed * (maxRequests / windowMs);
    const level = Math.max(0, bucket.water - leaked);
    if(level < maxRequests){
      this.store.set(key, { water: level + 1, lastLeak: now });
      return true;
    }
    this.store.set(key, { water: level, lastLeak: now });
    return false;
  }
}
