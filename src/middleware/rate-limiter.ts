interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}
interface RequestRecord {
  count: number;
  windowStart: number;
}
export class RateLimiter {
  private ipMap: Map<string, RequestRecord> = new Map();
  private windowMs: number;
  private maxRequests: number;
  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    setInterval(() => {
      this.cleanup();
    }, config.windowMs);
  }
  isAllowed(ip: string): boolean {
    const now = Date.now();
    const record = this.ipMap.get(ip);
    if (!record) {
      this.ipMap.set(ip, {
        count: 1,
        windowStart: now,
      });
      return true;
    }
    if (now - record.windowStart > this.windowMs) {
      this.ipMap.set(ip, {
        count: 1,
        windowStart: now,
      });
      return true;
    }
    if (record.count >= this.maxRequests) {
      return false;
    }
    record.count++;
    return true;
  }
  getRemainingRequests(ip: string): number {
    const record = this.ipMap.get(ip);
    if (!record) return this.maxRequests;
    return Math.max(0, this.maxRequests - record.count);
  }
  getResetTime(ip: string): number {
    const record = this.ipMap.get(ip);
    if (!record) return Date.now() + this.windowMs;
    return record.windowStart + this.windowMs;
  }
  private cleanup(): void {
    const now = Date.now();
    for (const [ip, record] of this.ipMap.entries()) {
      // if the current time - time when window started is more than window running time so delete IP
      if (now - record.windowStart > this.windowMs) {
        this.ipMap.delete(ip);
      }
    }
    // after cleaning previous dead IP, resulting Map with alive IPs
    console.log(`[RateLimiter] Cleaned up. Active IPs: ${this.ipMap.size}`);
  }
}
