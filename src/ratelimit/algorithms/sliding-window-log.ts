import { BoundedStore } from "../bounded-store.js";

interface SlidingWindowLogEntry {
  timestamps: number[];
  windowMs: number;
}

export class SlidingWindowLogAlgorithm {
  // An entry is stale once every timestamp it holds has aged out of its own window — at that
  // point it carries no information a fresh key wouldn't, so it's safe to reclaim.
  private store = new BoundedStore<SlidingWindowLogEntry>((entry, now) =>
    entry.timestamps.every((t) => now - t >= entry.windowMs),
  );

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    let timestamps = this.store.get(key)?.timestamps ?? [];
    timestamps = timestamps.filter(t => now - t < windowMs);
    if(timestamps.length < maxRequests){
      timestamps.push(now);
      this.store.set(key, { timestamps, windowMs });
      return true;
    }
    this.store.set(key, { timestamps, windowMs });
    return false;
  }
  getState(key: string, windowMs: number){
    const now = Date.now();
    const timestamps = (this.store.get(key)?.timestamps ?? []).filter(t => now - t < windowMs);
    return {
      activeTimestampsCount: timestamps.length,
      oldestRequestAgeMs: timestamps.length > 0 && timestamps[0] !== undefined ? now - timestamps[0] : 0,
    };
  }
}
