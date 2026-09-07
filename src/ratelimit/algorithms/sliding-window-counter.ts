export class SlidingWindowCounterAlgorithm {
  private store = new Map<string, { currentCount: number; prevCount: number; windowStart: number }>();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    let data = this.store.get(key);
    if(!data || now - data.windowStart >= windowMs * 2){
      data = { currentCount: 0, prevCount: 0, windowStart: now };
      this.store.set(key, data);
    }else if(now - data.windowStart >= windowMs){
      data.prevCount = data.currentCount;
      data.currentCount = 0;
      data.windowStart += windowMs;
    }
    const weight = (windowMs - (now - data.windowStart)) / windowMs;
    const estimated = Math.floor(data.prevCount * weight + data.currentCount);
    if(estimated < maxRequests){
      data.currentCount++;
      return true;
    }
    return false;
  }
  getState(key: string, windowMs: number) {
    const now = Date.now();
    const data = this.store.get(key) ?? { currentCount: 0, prevCount: 0, windowStart: now };
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
