import { BoundedStore } from "../bounded-store.js";

interface SlidingWindowCounterEntry {
  currentCount: number;
  prevCount: number;
  windowStart: number;
  windowMs: number;
}

export class SlidingWindowCounterAlgorithm {
  // Matches the algorithm's own reset condition: once `windowMs*2` has elapsed since
  // windowStart, check() discards prevCount/currentCount anyway, so the entry carries no
  // information a fresh key wouldn't.
  private store = new BoundedStore<SlidingWindowCounterEntry>(
    (entry, now) => now - entry.windowStart >= entry.windowMs * 2,
  );

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    let data = this.store.get(key);
    if(!data || now - data.windowStart >= windowMs * 2){
      data = { currentCount: 0, prevCount: 0, windowStart: now, windowMs };
    }else if(now - data.windowStart >= windowMs){
      data.prevCount = data.currentCount;
      data.currentCount = 0;
      data.windowStart += windowMs;
      data.windowMs = windowMs;
    }
    const weight = (windowMs - (now - data.windowStart)) / windowMs;
    const estimated = Math.floor(data.prevCount * weight + data.currentCount);
    if(estimated < maxRequests){
      data.currentCount++;
      this.store.set(key, data);
      return true;
    }
    this.store.set(key, data);
    return false;
  }
  getState(key: string, windowMs: number) {
    const now = Date.now();
    const data = this.store.get(key) ?? { currentCount: 0, prevCount: 0, windowStart: now, windowMs };
    const timeIntoWindow = now - data.windowStart;
    const weight = Math.max(0, (windowMs - timeIntoWindow) / windowMs);
    const estimated = Math.floor(data.prevCount * weight + data.currentCount);
    return {
      currentCount: data.currentCount,
      prevCount: data.prevCount,
      previousWindowWeight: parseFloat(weight.toFixed(2)),
      estimatedTotalCount: estimated,
    };
  }
}
