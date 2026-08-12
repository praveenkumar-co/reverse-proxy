import { logger } from "./logger.js";

export type RateLimitAlgorithm =
  | "fixed-window"
  | "sliding-window"
  | "token-bucket";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  algorithm?: RateLimitAlgorithm;
}

interface FWRecord {
  count: number;
  windowStart: number;
}
interface SWRecord {
  timestamps: number[];
}

interface TBRecord {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly algorithm: RateLimitAlgorithm;
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly refillRate: number;
  private readonly fwMap = new Map<string, FWRecord>();
  private readonly swMap = new Map<string, SWRecord>();
  private readonly tbMap = new Map<string, TBRecord>();

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this.algorithm = config.algorithm ?? "sliding-window";
    this.refillRate = this.maxRequests / this.windowMs;
    setInterval(() => {
      this.cleanup();
    }, this.windowMs);
  }

  isAllowed(ip: string): boolean {
    switch (this.algorithm) {
      case "fixed-window":   return this._fwIsAllowed(ip);
      case "sliding-window": return this._swIsAllowed(ip);
      case "token-bucket":   return this._tbIsAllowed(ip);
    }
  }
  getRemainingRequests(ip: string): number {
    switch (this.algorithm) {
      case "fixed-window": {
        const r = this.fwMap.get(ip);
        if (!r) return this.maxRequests;
        return Math.max(0, this.maxRequests - r.count);
      }
      case "sliding-window": {
        const r = this.swMap.get(ip);
        if (!r) return this.maxRequests;
        const cutoff = Date.now() - this.windowMs;
        const active = r.timestamps.filter((t) => t > cutoff).length;
        return Math.max(0, this.maxRequests - active);
      }
      case "token-bucket": {
        const r = this.tbMap.get(ip);
        if (!r) return this.maxRequests;
        const refilled = r.tokens + (Date.now() - r.lastRefill) * this.refillRate;
        return Math.min(this.maxRequests, Math.floor(refilled));
      }
    }
  }
  getResetTime(ip: string): number {
    const now = Date.now();
    switch (this.algorithm) {
      case "fixed-window": {
        const r = this.fwMap.get(ip);
        return r ? r.windowStart + this.windowMs : now + this.windowMs;
      }
      case "sliding-window": {
        const r = this.swMap.get(ip);
        if (!r || r.timestamps.length === 0) return now + this.windowMs;
        // The oldest timestamp in the window expires first
        return r.timestamps[0]! + this.windowMs;
      }
      case "token-bucket": {
        const r = this.tbMap.get(ip);
        if (!r) return now;
        const deficit = 1 - r.tokens;
        if (deficit <= 0) return now;
        return Math.ceil(r.lastRefill + deficit / this.refillRate);
      }
    }
  }
  getAlgorithm(): RateLimitAlgorithm {
    return this.algorithm;
  }

  private _fwIsAllowed(ip: string): boolean {
    const now = Date.now();
    const record = this.fwMap.get(ip);

    if (!record) {
      this.fwMap.set(ip, { count: 1, windowStart: now });
      return true;
    }

    // Window expired open a fresh one.
    if (now - record.windowStart > this.windowMs) {
      this.fwMap.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (record.count >= this.maxRequests) return false;
    record.count++;
    return true;
  }

  private _swIsAllowed(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let record = this.swMap.get(ip);
    if (!record) {
      record = { timestamps: [] };
      this.swMap.set(ip, record);
    }
    let lo = 0;
    let hi = record.timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (record.timestamps[mid]! <= cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) record.timestamps = record.timestamps.slice(lo);

    if (record.timestamps.length >= this.maxRequests) return false;
    record.timestamps.push(now);
    return true;
  }
  private _tbIsAllowed(ip: string): boolean {
    const now = Date.now();

    let record = this.tbMap.get(ip);
    if (!record) {
      this.tbMap.set(ip, {
        tokens: this.maxRequests - 1,
        lastRefill: now,
      });
      return true;
    }
    const elapsed = now - record.lastRefill;
    record.tokens = Math.min(
      this.maxRequests,
      record.tokens + elapsed * this.refillRate,
    );
    record.lastRefill = now;

    if (record.tokens < 1) return false;
    record.tokens -= 1;
    return true;
  }
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [ip, record] of this.fwMap.entries()) {
      if (now - record.windowStart > this.windowMs) {
        this.fwMap.delete(ip);
        removed++;
      }
    }
    const cutoff = now - this.windowMs;
    for (const [ip, record] of this.swMap.entries()) {
      record.timestamps = record.timestamps.filter((t) => t > cutoff);
      if (record.timestamps.length === 0) {
        this.swMap.delete(ip);
        removed++;
      }
    }
    for (const [ip, record] of this.tbMap.entries()) {
      const current =
        record.tokens + (now - record.lastRefill) * this.refillRate;
      if (current >= this.maxRequests) {
        this.tbMap.delete(ip);
        removed++;
      }
    }
    logger.info("RateLimiter", "Cleanup done", {
      algorithm: this.algorithm,
      removed,
      active: { fw: this.fwMap.size, sw: this.swMap.size, tb: this.tbMap.size },
    });
  }
}