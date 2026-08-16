export class FixedWindowAlgorithm {
  private store = new Map<string, { count: number; resetTime: number }>();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const data = this.store.get(key);
    if (!data || now >= data.resetTime) {
      this.store.set(key, { count: 1, resetTime: now + windowMs });
      return true;
    }
    if (data.count < maxRequests) {
      data.count++;
      return true;
    }
    return false;
  }

  getResetTime(key: string): number {
    return this.store.get(key)?.resetTime ?? Date.now();
  }
}
