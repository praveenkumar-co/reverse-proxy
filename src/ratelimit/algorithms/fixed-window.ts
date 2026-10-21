import { BoundedStore } from "../bounded-store.js";

interface FixedWindowEntry {
  count: number;
  resetTime: number;
}

export class FixedWindowAlgorithm {
  private store = new BoundedStore<FixedWindowEntry>((entry, now) => now >= entry.resetTime);

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const data = this.store.get(key);
    if(!data || now >= data.resetTime){
      this.store.set(key, { count: 1, resetTime: now + windowMs });
      return true;
    }
    if(data.count < maxRequests){
      data.count++;
      this.store.set(key, data);
      return true;
    }
    return false;
  }
  getState(key: string) {
    const data = this.store.get(key);
    return {
      currentCount: data?.count ?? 0,
      resetInSec: data ? Math.max(0, Math.ceil((data.resetTime - Date.now()) / 1000)) : 0,
    };
  }
  getResetTime(key: string): number {
    return this.store.get(key)?.resetTime ?? Date.now();
  }
}
