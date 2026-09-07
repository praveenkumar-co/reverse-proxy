export class SlidingWindowLogAlgorithm {
  private store = new Map<string, number[]>();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    let timestamps = this.store.get(key) ?? [];
    timestamps = timestamps.filter(t => now - t < windowMs);
    if(timestamps.length < maxRequests){
      timestamps.push(now);
      this.store.set(key, timestamps);
      return true;
    }
    this.store.set(key, timestamps);
    return false;
  }
  getState(key: string, windowMs: number) {
    const now = Date.now();
    const timestamps = (this.store.get(key) ?? []).filter(t => now - t < windowMs);
    return {
      activeTimestampsCount: timestamps.length,
      oldestRequestAgeMs: timestamps.length > 0 && timestamps[0] !== undefined ? now - timestamps[0] : 0,
    };
  }
}
