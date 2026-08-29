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
}
