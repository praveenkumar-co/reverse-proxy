export class FixedWindowAlgorithm {
  private store = new Map<string, { count: number; resetTime: number }>();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const data = this.store.get(key);
    if(!data || now >= data.resetTime){
      this.store.set(key, { count: 1, resetTime: now + windowMs });
      return true;
    }
    if(data.count < maxRequests){
      data.count++;
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
