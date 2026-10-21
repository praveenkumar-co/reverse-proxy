import { BoundedStore } from "../bounded-store.js";

interface LeakingBucketEntry {
  water: number;
  lastLeak: number;
  maxRequests: number;
  windowMs: number;
}

export class LeakingBucketAlgorithm {
  // Once `windowMs` has elapsed since the last leak, the bucket is guaranteed to have fully
  // drained back to 0 — identical to a fresh key's default state — so it can be reclaimed.
  private store = new BoundedStore<LeakingBucketEntry>(
    (entry, now) => now - entry.lastLeak >= entry.windowMs,
  );

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = this.store.get(key) ?? { water: 0, lastLeak: now, maxRequests, windowMs };
    const elapsed = now - bucket.lastLeak;
    const leaked = elapsed * (maxRequests / windowMs);
    const level = Math.max(0, bucket.water - leaked);
    if(level + 1 <= maxRequests){
      this.store.set(key, { water: level + 1, lastLeak: now, maxRequests, windowMs });
      return true;
    }
    this.store.set(key, { water: level, lastLeak: now, maxRequests, windowMs });
    return false;
  }
  getState(key: string, maxRequests: number, windowMs: number) {
    const now = Date.now();
    const bucket = this.store.get(key) ?? { water: 0, lastLeak: now, maxRequests, windowMs };
    const elapsed = now - bucket.lastLeak;
    const leaked = elapsed * (maxRequests / windowMs);
    const level = Math.max(0, bucket.water - leaked);
    return {
      waterLevel: parseFloat(level.toFixed(2)),
      capacity: maxRequests,
    };
  }
}
