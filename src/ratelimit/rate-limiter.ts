import type { RedisClientType } from "redis";
import { logger } from "../observability/logger/logger.js";

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  algorithm:
    | "fixed-window"
    | "sliding-window"
    | "sliding-window-log"
    | "sliding-window-counter"
    | "token-bucket"
    | "leaking-bucket";
  storage?: "memory" | "redis" | "hybrid" | undefined;
  redisClient?: RedisClientType | undefined;
}

export class RateLimiter {
  private windowMs: number;
  private maxRequests: number;
  private algorithm: string;
  private storage: string;
  private redisClient?: RedisClientType | undefined;

  // In-memory data stores
  private fwMap = new Map<string, { count: number; resetTime: number }>();
  private swLogMap = new Map<string, number[]>();
  private swCounterMap = new Map<string, { currentCount: number; prevCount: number; windowStart: number }>();
  private tbMap = new Map<string, { tokens: number; lastRefill: number }>();
  private lbMap = new Map<string, { water: number; lastLeak: number }>();

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
    this.algorithm = options.algorithm === "sliding-window" ? "sliding-window-log" : options.algorithm;
    this.storage = options.storage ?? "memory";
    this.redisClient = options.redisClient;
  }

  public getAlgorithm(): string {
    return this.algorithm;
  }

  public getResetTime(ip: string): number {
    const now = Date.now();
    if (this.algorithm === "fixed-window") {
      const data = this.fwMap.get(ip);
      return data ? data.resetTime : now + this.windowMs;
    }
    return now + this.windowMs;
  }

  public isAllowed(ip: string): boolean | Promise<boolean> {
    if (this.storage === 'redis' && this.redisClient) {
      return this.isAllowedRedis(ip).catch((err: any) => {
        return this.isAllowedMemory(ip);
      });
    }
    return this.isAllowedMemory(ip);
  }

  private isAllowedMemory(ip: string): boolean {
    const now = Date.now();

    switch (this.algorithm) {
      case "fixed-window": {
        const data = this.fwMap.get(ip);
        if (!data || now >= data.resetTime) {
          this.fwMap.set(ip, { count: 1, resetTime: now + this.windowMs });
          return true;
        }
        if (data.count < this.maxRequests) {
          data.count++;
          return true;
        }
        return false;
      }

      case "sliding-window-log": {
        let timestamps = this.swLogMap.get(ip) || [];
        timestamps = timestamps.filter((t) => now - t < this.windowMs);
        if (timestamps.length < this.maxRequests) {
          timestamps.push(now);
          this.swLogMap.set(ip, timestamps);
          return true;
        }
        this.swLogMap.set(ip, timestamps);
        return false;
      }

      case "sliding-window-counter": {
        let data = this.swCounterMap.get(ip);
        if (!data || now - data.windowStart >= this.windowMs * 2) {
          data = { currentCount: 0, prevCount: 0, windowStart: now };
          this.swCounterMap.set(ip, data);
        } else if (now - data.windowStart >= this.windowMs) {
          data.prevCount = data.currentCount;
          data.currentCount = 0;
          data.windowStart = data.windowStart + this.windowMs;
        }
        const timeIntoCurrentWindow = now - data.windowStart;
        const weight = (this.windowMs - timeIntoCurrentWindow) / this.windowMs;
        const estimatedCount = Math.floor(data.prevCount * weight + data.currentCount);
        if (estimatedCount < this.maxRequests) {
          data.currentCount++;
          return true;
        }
        return false;
      }

      case "token-bucket": {
        let bucket = this.tbMap.get(ip);
        if (!bucket) {
          bucket = { tokens: this.maxRequests, lastRefill: now };
        }
        const elapsed = now - bucket.lastRefill;
        const refillRate = this.maxRequests / this.windowMs;
        const newTokens = Math.min(this.maxRequests, bucket.tokens + elapsed * refillRate);
        if (newTokens >= 1) {
          bucket.tokens = newTokens - 1;
          bucket.lastRefill = now;
          this.tbMap.set(ip, bucket);
          return true;
        }
        bucket.tokens = newTokens;
        bucket.lastRefill = now;
        this.tbMap.set(ip, bucket);
        return false;
      }

      case "leaking-bucket": {
        let bucket = this.lbMap.get(ip);
        if (!bucket) {
          bucket = { water: 0, lastLeak: now };
        }
        const elapsed = now - bucket.lastLeak;
        const leakRate = this.maxRequests / this.windowMs;
        const leaked = elapsed * leakRate;
        const waterLevel = Math.max(0, bucket.water - leaked);
        if (waterLevel < this.maxRequests) {
          bucket.water = waterLevel + 1;
          bucket.lastLeak = now;
          this.lbMap.set(ip, bucket);
          return true;
        }
        bucket.water = waterLevel;
        bucket.lastLeak = now;
        this.lbMap.set(ip, bucket);
        return false;
      }

      default:
        return true;
    }
  }

  private async isAllowedRedis(ip: string): Promise<boolean> {
    const client = this.redisClient!;
    const now = Date.now();
    const key = `rl:${this.algorithm}:${ip}`;

    switch (this.algorithm) {
      case "fixed-window": {
        const count = await client.incr(key);
        if (count === 1) {
          await client.pExpire(key, this.windowMs);
        }
        return count <= this.maxRequests;
      }

      case "sliding-window-log": {
        const threshold = now - this.windowMs;
        await client.zRemRangeByScore(key, "-inf", threshold);
        const count = await client.zCard(key);
        if (count < this.maxRequests) {
          await client.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
          await client.pExpire(key, this.windowMs);
          return true;
        }
        return false;
      }

      case "token-bucket": {
        const state = await client.hGetAll(key);
        let tokens = this.maxRequests;
        let lastRefill = now;

        if (state && state.tokens && state.lastRefill) {
          tokens = parseFloat(state.tokens);
          lastRefill = parseInt(state.lastRefill, 10);
        }

        const elapsed = now - lastRefill;
        const refillRate = this.maxRequests / this.windowMs;
        const newTokens = Math.min(this.maxRequests, tokens + elapsed * refillRate);

        if (newTokens >= 1) {
          await client.hSet(key, {
            tokens: (newTokens - 1).toString(),
            lastRefill: now.toString(),
          });
          await client.pExpire(key, this.windowMs);
          return true;
        }

        await client.hSet(key, {
          tokens: newTokens.toString(),
          lastRefill: now.toString(),
        });
        await client.pExpire(key, this.windowMs);
        return false;
      }

      default:
        // Default to memory mode for counter / leaking bucket if not natively coded in Redis script
        return this.isAllowedMemory(ip);
    }
  }
}
