import type { RedisClientType } from "redis";
import { FixedWindowAlgorithm } from "./algorithms/fixed-window.js";
import { SlidingWindowLogAlgorithm } from "./algorithms/sliding-window-log.js";
import { SlidingWindowCounterAlgorithm } from "./algorithms/sliding-window-counter.js";
import { TokenBucketAlgorithm } from "./algorithms/token-bucket.js";
import { LeakingBucketAlgorithm } from "./algorithms/leaking-bucket.js";
import { SoftLimitPolicy } from "./policies/soft-limit.policy.js";
import { MultiDimensionPolicy, type DimensionConfig } from "./policies/multi-dimension.policy.js";
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
  softLimit?: number | undefined;
  burstMultiplier?: number | undefined;
  dimensions?: DimensionConfig[] | undefined;
}

export class RateLimiter {
  private windowMs: number;
  private maxRequests: number;
  private algorithm: string;
  private storage: string;
  private redisClient?: RedisClientType | undefined;

  // Delegated Algorithm instances
  private fwAlgo = new FixedWindowAlgorithm();
  private swLogAlgo = new SlidingWindowLogAlgorithm();
  private swCounterAlgo = new SlidingWindowCounterAlgorithm();
  private tbAlgo = new TokenBucketAlgorithm();
  private lbAlgo = new LeakingBucketAlgorithm();

  // Integrated Policies
  private softLimitPolicy?: SoftLimitPolicy | undefined;
  private multiDimensionPolicy?: MultiDimensionPolicy | undefined;

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
    this.algorithm = options.algorithm === "sliding-window" ? "sliding-window-log" : options.algorithm;
    this.storage = options.storage ?? "memory";
    this.redisClient = options.redisClient;

    if (options.softLimit !== undefined) {
      this.softLimitPolicy = new SoftLimitPolicy(
        this.maxRequests,
        options.softLimit,
        options.burstMultiplier ?? 1.5
      );
    }

    if (options.dimensions !== undefined) {
      this.multiDimensionPolicy = new MultiDimensionPolicy(options.dimensions);
    }
  }

  public getAlgorithm(): string {
    return this.algorithm;
  }

  public getResetTime(ip: string): number {
    const now = Date.now();
    if (this.algorithm === "fixed-window") {
      return this.fwAlgo.getResetTime(ip);
    }
    return now + this.windowMs;
  }

  public isAllowed(
    ip: string,
    context?: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): boolean | Promise<boolean> {
    if (this.multiDimensionPolicy && context) {
      if (this.storage === 'redis' && this.redisClient) {
        return this.isAllowedMultiDimensionRedis(ip, context).catch((err: any) => {
          logger.error("RateLimiter", `Redis multi-dimension limit failed, falling back to memory: ${err.message}`);
          return this.isAllowedMultiDimensionMemory(ip, context);
        });
      }
      return this.isAllowedMultiDimensionMemory(ip, context);
    }

    if (this.storage === 'redis' && this.redisClient) {
      return this.isAllowedRedis(ip).catch((err: any) => {
        logger.error("RateLimiter", `Redis single-dimension limit failed, falling back to memory: ${err.message}`);
        return this.isAllowedMemory(ip);
      });
    }
    return this.isAllowedMemory(ip);
  }

  public getRemaining(ip: string): number | Promise<number> {
    if (this.storage === 'redis' && this.redisClient) {
      return this.getCurrentLoadRedis(ip).then((load) => Math.max(0, this.maxRequests - load));
    }
    return Math.max(0, this.maxRequests - this.getCurrentLoadMemory(ip));
  }

  private isAllowedMemory(ip: string): boolean {
    let limit = this.maxRequests;
    if (this.softLimitPolicy) {
      const load = this.getCurrentLoadMemory(ip);
      limit = this.softLimitPolicy.effectiveLimit(load);
    }
    return this.checkMemory(ip, limit, this.windowMs);
  }

  private async isAllowedRedis(ip: string): Promise<boolean> {
    let limit = this.maxRequests;
    if (this.softLimitPolicy) {
      const load = await this.getCurrentLoadRedis(ip);
      limit = this.softLimitPolicy.effectiveLimit(load);
    }
    return this.checkRedis(ip, limit, this.windowMs);
  }

  private isAllowedMultiDimensionMemory(
    ip: string,
    context: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): boolean {
    const dimensions = this.multiDimensionPolicy!.getDimensions();
    for (const d of dimensions) {
      const val = this.getDimensionValue(d, ip, context);
      if (val === undefined) continue;
      const key = this.multiDimensionPolicy!.buildKey(d.dimension, val, context.route ?? '');
      let limit = d.maxRequests;
      if (this.softLimitPolicy) {
        const load = this.getCurrentLoadMemory(key);
        limit = this.softLimitPolicy.effectiveLimit(load);
      }
      const allowed = this.checkMemory(key, limit, d.windowMs);
      if (!allowed) return false;
    }
    return true;
  }

  private async isAllowedMultiDimensionRedis(
    ip: string,
    context: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): Promise<boolean> {
    const dimensions = this.multiDimensionPolicy!.getDimensions();
    for (const d of dimensions) {
      const val = this.getDimensionValue(d, ip, context);
      if (val === undefined) continue;
      const key = this.multiDimensionPolicy!.buildKey(d.dimension, val, context.route ?? '');
      let limit = d.maxRequests;
      if (this.softLimitPolicy) {
        const load = await this.getCurrentLoadRedis(key);
        limit = this.softLimitPolicy.effectiveLimit(load);
      }
      const allowed = await this.checkRedis(key, limit, d.windowMs);
      if (!allowed) return false;
    }
    return true;
  }

  private checkMemory(key: string, limit: number, windowMs: number): boolean {
    switch (this.algorithm) {
      case "fixed-window":
        return this.fwAlgo.check(key, limit, windowMs);
      case "sliding-window-log":
        return this.swLogAlgo.check(key, limit, windowMs);
      case "sliding-window-counter":
        return this.swCounterAlgo.check(key, limit, windowMs);
      case "token-bucket":
        return this.tbAlgo.check(key, limit, windowMs);
      case "leaking-bucket":
        return this.lbAlgo.check(key, limit, windowMs);
      default:
        return true;
    }
  }

  private async checkRedis(key: string, limit: number, windowMs: number): Promise<boolean> {
    const client = this.redisClient!;
    const now = Date.now();
    const redisKey = `rl:${this.algorithm}:${key}`;

    switch (this.algorithm) {
      case "fixed-window": {
        const count = await client.incr(redisKey);
        if (count === 1) {
          await client.pExpire(redisKey, windowMs);
        }
        return count <= limit;
      }

      case "sliding-window-log": {
        const threshold = now - windowMs;
        await client.zRemRangeByScore(redisKey, "-inf", threshold);
        const count = await client.zCard(redisKey);
        if (count < limit) {
          await client.zAdd(redisKey, { score: now, value: `${now}-${Math.random()}` });
          await client.pExpire(redisKey, windowMs);
          return true;
        }
        return false;
      }

      case "sliding-window-counter": {
        const state = await client.hGetAll(redisKey);
        let currentCount = 0;
        let prevCount = 0;
        let windowStart = now;

        if (state && state.currentCount) {
          currentCount = parseInt(state.currentCount, 10);
          prevCount = parseInt(state.prevCount ?? "0", 10);
          windowStart = parseInt(state.windowStart ?? "0", 10);
        }

        if (now - windowStart >= windowMs * 2) {
          currentCount = 0;
          prevCount = 0;
          windowStart = now;
        } else if (now - windowStart >= windowMs) {
          prevCount = currentCount;
          currentCount = 0;
          windowStart = windowStart + windowMs;
        }

        const timeIntoCurrentWindow = now - windowStart;
        const weight = (windowMs - timeIntoCurrentWindow) / windowMs;
        const estimatedCount = Math.floor(prevCount * weight + currentCount);

        if (estimatedCount < limit) {
          currentCount++;
          await client.hSet(redisKey, {
            currentCount: currentCount.toString(),
            prevCount: prevCount.toString(),
            windowStart: windowStart.toString(),
          });
          await client.pExpire(redisKey, windowMs * 2);
          return true;
        }

        await client.hSet(redisKey, {
          currentCount: currentCount.toString(),
          prevCount: prevCount.toString(),
          windowStart: windowStart.toString(),
        });
        await client.pExpire(redisKey, windowMs * 2);
        return false;
      }

      case "token-bucket": {
        const state = await client.hGetAll(redisKey);
        let tokens = limit;
        let lastRefill = now;

        if (state && state.tokens && state.lastRefill) {
          tokens = parseFloat(state.tokens);
          lastRefill = parseInt(state.lastRefill, 10);
        }

        const elapsed = now - lastRefill;
        const refillRate = limit / windowMs;
        const newTokens = Math.min(limit, tokens + elapsed * refillRate);

        if (newTokens >= 1) {
          await client.hSet(redisKey, {
            tokens: (newTokens - 1).toString(),
            lastRefill: now.toString(),
          });
          await client.pExpire(redisKey, windowMs);
          return true;
        }

        await client.hSet(redisKey, {
          tokens: newTokens.toString(),
          lastRefill: now.toString(),
        });
        await client.pExpire(redisKey, windowMs);
        return false;
      }

      case "leaking-bucket": {
        const state = await client.hGetAll(redisKey);
        let water = 0.0;
        let lastLeak = now;

        if (state && state.water && state.lastLeak) {
          water = parseFloat(state.water);
          lastLeak = parseInt(state.lastLeak, 10);
        }

        const elapsed = now - lastLeak;
        const leakRate = limit / windowMs;
        const leaked = elapsed * leakRate;
        const waterLevel = Math.max(0.0, water - leaked);

        if (waterLevel < limit) {
          await client.hSet(redisKey, {
            water: (waterLevel + 1).toString(),
            lastLeak: now.toString(),
          });
          await client.pExpire(redisKey, windowMs);
          return true;
        }

        await client.hSet(redisKey, {
          water: waterLevel.toString(),
          lastLeak: now.toString(),
        });
        await client.pExpire(redisKey, windowMs);
        return false;
      }

      default:
        return true;
    }
  }

  private getCurrentLoadMemory(key: string): number {
    const now = Date.now();
    switch (this.algorithm) {
      case "fixed-window": {
        const resetTime = this.fwAlgo.getResetTime(key);
        return now >= resetTime ? 0 : (this.fwAlgo["store"].get(key)?.count ?? 0);
      }
      case "sliding-window-log": {
        const list = this.swLogAlgo["store"].get(key) ?? [];
        return list.filter((t) => now - t < this.windowMs).length;
      }
      case "sliding-window-counter": {
        const data = this.swCounterAlgo["store"].get(key);
        if (!data) return 0;
        const timeIntoCurrentWindow = now - data.windowStart;
        const weight = (this.windowMs - timeIntoCurrentWindow) / this.windowMs;
        return Math.floor(data.prevCount * weight + data.currentCount);
      }
      case "token-bucket": {
        const bucket = this.tbAlgo["store"].get(key);
        return bucket ? Math.max(0, this.maxRequests - bucket.tokens) : 0;
      }
      case "leaking-bucket": {
        return this.lbAlgo["store"].get(key)?.water ?? 0;
      }
      default:
        return 0;
    }
  }

  private async getCurrentLoadRedis(key: string): Promise<number> {
    const client = this.redisClient!;
    const redisKey = `rl:${this.algorithm}:${key}`;
    try {
      switch (this.algorithm) {
        case "fixed-window": {
          const val = await client.get(redisKey);
          return val ? parseInt(val, 10) : 0;
        }
        case "sliding-window-log": {
          const threshold = Date.now() - this.windowMs;
          await client.zRemRangeByScore(redisKey, "-inf", threshold);
          return await client.zCard(redisKey);
        }
        case "token-bucket": {
          const tokens = await client.hGet(redisKey, "tokens");
          return tokens ? Math.max(0, this.maxRequests - parseFloat(tokens)) : 0;
        }
        case "leaking-bucket": {
          const water = await client.hGet(redisKey, "water");
          return water ? parseFloat(water) : 0.0;
        }
        case "sliding-window-counter": {
          const state = await client.hGetAll(redisKey);
          if (!state || !state.currentCount) return 0;
          const currentCount = parseInt(state.currentCount, 10);
          const prevCount = parseInt(state.prevCount ?? "0", 10);
          const windowStart = parseInt(state.windowStart ?? "0", 10);
          const now = Date.now();
          const timeIntoCurrentWindow = now - windowStart;
          const weight = (this.windowMs - timeIntoCurrentWindow) / this.windowMs;
          return Math.floor(prevCount * weight + currentCount);
        }
        default:
          return 0;
      }
    } catch {
      return 0;
    }
  }

  private getDimensionValue(
    d: DimensionConfig,
    ip: string,
    context: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): string | undefined {
    switch (d.dimension) {
      case "ip":
        return ip;
      case "api-key":
        return context.apiKey;
      case "route":
        return context.route;
      case "header":
        if (d.headerName) {
          const raw = context.headers?.[d.headerName.toLowerCase()];
          return Array.isArray(raw) ? raw[0] : raw;
        }
        return undefined;
      default:
        return undefined;
    }
  }
}
