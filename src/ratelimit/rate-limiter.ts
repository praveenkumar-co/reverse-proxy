import type { RedisClientType } from "redis";
import { FixedWindowAlgorithm } from "./algorithms/fixed-window.js";
import { SlidingWindowLogAlgorithm } from "./algorithms/sliding-window-log.js";
import { SlidingWindowCounterAlgorithm } from "./algorithms/sliding-window-counter.js";
import { TokenBucketAlgorithm } from "./algorithms/token-bucket.js";
import { LeakingBucketAlgorithm } from "./algorithms/leaking-bucket.js";
import { SoftLimitPolicy } from "./policies/soft-limit.policy.js";
import { MultiDimensionPolicy, type DimensionConfig } from "./policies/multi-dimension.policy.js";
import { logger } from "../observability/logger/logger.js";

const REDIS_RATE_LIMIT_SCRIPTS = {
  fixedWindow: `
    local count = redis.call("INCR", KEYS[1])
    if count == 1 then
      redis.call("PEXPIRE", KEYS[1], ARGV[2])
    end
    if count <= tonumber(ARGV[1]) then
      return 1
    end
    return 0
  `,
  slidingWindowLog: `
    local threshold = tonumber(ARGV[2]) - tonumber(ARGV[3])
    redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", threshold)
    local count = redis.call("ZCARD", KEYS[1])
    if count < tonumber(ARGV[1]) then
      local sequence = redis.call("INCR", KEYS[2])
      redis.call("ZADD", KEYS[1], ARGV[2], ARGV[2] .. "-" .. sequence)
      redis.call("PEXPIRE", KEYS[1], ARGV[3])
      redis.call("PEXPIRE", KEYS[2], ARGV[3])
      return 1
    end
    redis.call("PEXPIRE", KEYS[1], ARGV[3])
    return 0
  `,
  slidingWindowCounter: `
    local state = redis.call("HMGET", KEYS[1], "currentCount", "prevCount", "windowStart")
    local currentCount = tonumber(state[1]) or 0
    local prevCount = tonumber(state[2]) or 0
    local windowStart = tonumber(state[3]) or tonumber(ARGV[2])
    local now = tonumber(ARGV[2])
    local windowMs = tonumber(ARGV[3])

    if now - windowStart >= windowMs * 2 then
      currentCount = 0
      prevCount = 0
      windowStart = now
    elseif now - windowStart >= windowMs then
      prevCount = currentCount
      currentCount = 0
      windowStart = windowStart + windowMs
    end

    local timeIntoCurrentWindow = now - windowStart
    local weight = (windowMs - timeIntoCurrentWindow) / windowMs
    local estimatedCount = math.floor(prevCount * weight + currentCount)

    if estimatedCount < tonumber(ARGV[1]) then
      currentCount = currentCount + 1
      redis.call("HSET", KEYS[1], "currentCount", currentCount, "prevCount", prevCount, "windowStart", windowStart)
      redis.call("PEXPIRE", KEYS[1], windowMs * 2)
      return 1
    end

    redis.call("HSET", KEYS[1], "currentCount", currentCount, "prevCount", prevCount, "windowStart", windowStart)
    redis.call("PEXPIRE", KEYS[1], windowMs * 2)
    return 0
  `,
  tokenBucket: `
    local state = redis.call("HMGET", KEYS[1], "tokens", "lastRefill")
    local limit = tonumber(ARGV[1])
    local now = tonumber(ARGV[2])
    local windowMs = tonumber(ARGV[3])
    local tokens = tonumber(state[1]) or limit
    local lastRefill = tonumber(state[2]) or now
    local elapsed = now - lastRefill
    local refillRate = limit / windowMs
    local newTokens = math.min(limit, tokens + elapsed * refillRate)

    if newTokens >= 1 then
      redis.call("HSET", KEYS[1], "tokens", newTokens - 1, "lastRefill", now)
      redis.call("PEXPIRE", KEYS[1], windowMs)
      return 1
    end

    redis.call("HSET", KEYS[1], "tokens", newTokens, "lastRefill", now)
    redis.call("PEXPIRE", KEYS[1], windowMs)
    return 0
  `,
  leakingBucket: `
    local state = redis.call("HMGET", KEYS[1], "water", "lastLeak")
    local limit = tonumber(ARGV[1])
    local now = tonumber(ARGV[2])
    local windowMs = tonumber(ARGV[3])
    local water = tonumber(state[1]) or 0
    local lastLeak = tonumber(state[2]) or now
    local elapsed = now - lastLeak
    local leakRate = limit / windowMs
    local leaked = elapsed * leakRate
    local waterLevel = math.max(0, water - leaked)

    if waterLevel < limit then
      redis.call("HSET", KEYS[1], "water", waterLevel + 1, "lastLeak", now)
      redis.call("PEXPIRE", KEYS[1], windowMs)
      return 1
    end

    redis.call("HSET", KEYS[1], "water", waterLevel, "lastLeak", now)
    redis.call("PEXPIRE", KEYS[1], windowMs)
    return 0
  `,
} as const;

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
  private fwAlgo = new FixedWindowAlgorithm();
  private swLogAlgo = new SlidingWindowLogAlgorithm();
  private swCounterAlgo = new SlidingWindowCounterAlgorithm();
  private tbAlgo = new TokenBucketAlgorithm();
  private lbAlgo = new LeakingBucketAlgorithm();
  private softLimitPolicy?: SoftLimitPolicy | undefined;
  private multiDimensionPolicy?: MultiDimensionPolicy | undefined;
  constructor(options: RateLimiterOptions){
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
    this.algorithm = options.algorithm === "sliding-window" ? "sliding-window-log" : options.algorithm;
    this.storage = options.storage ?? "memory";
    this.redisClient = options.redisClient;
    if(options.softLimit !== undefined){
      this.softLimitPolicy = new SoftLimitPolicy(
        this.maxRequests,
        options.softLimit,
        options.burstMultiplier ?? 1.5
      );
    }
    if(options.dimensions !== undefined){
      this.multiDimensionPolicy = new MultiDimensionPolicy(options.dimensions);
    }
  }
  public getAlgorithm(): string {
    return this.algorithm;
  }

  public getResetTime(ip: string): number {
    const now = Date.now();
    if(this.algorithm === "fixed-window"){
      return this.fwAlgo.getResetTime(ip);
    }
    return now + this.windowMs;
  }

  public isAllowed(
    ip: string,
    context?: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): boolean | Promise<boolean> {
    if(this.multiDimensionPolicy && context){
      if(this.storage === 'redis' && this.redisClient){
        return this.isAllowedMultiDimensionRedis(ip, context).catch((err: any) => {
          logger.error("RateLimiter", `Redis multi-dimension limit failed, falling back to memory: ${err.message}`);
          return this.isAllowedMultiDimensionMemory(ip, context);
        });
      }
      if(this.storage === 'hybrid' && this.redisClient){
        return this.isAllowedMultiDimensionHybrid(ip, context).catch((err: any) => {
          logger.error("RateLimiter", `Hybrid multi-dimension limit failed, falling back to memory: ${err.message}`);
          return this.isAllowedMultiDimensionMemory(ip, context);
        });
      }
      return this.isAllowedMultiDimensionMemory(ip, context);
    }

    if (this.storage === 'redis' && this.redisClient){
      return this.isAllowedRedis(ip).catch((err: any) => {
        logger.error("RateLimiter", `Redis single-dimension limit failed, falling back to memory: ${err.message}`);
        return this.isAllowedMemory(ip);
      });
    }
    if (this.storage === 'hybrid' && this.redisClient){
      return this.isAllowedHybrid(ip).catch((err: any) => {
        logger.error("RateLimiter", `Hybrid limit Redis check failed, falling back to memory: ${err.message}`);
        return this.isAllowedMemory(ip);
      });
    }
    return this.isAllowedMemory(ip);
  }

  public getRemaining(ip: string): number | Promise<number> {
    if ((this.storage === 'redis' || this.storage === 'hybrid') && this.redisClient){
      return this.getCurrentLoadRedis(ip).then((load) => Math.max(0, this.maxRequests - load));
    }
    return Math.max(0, this.maxRequests - this.getCurrentLoadMemory(ip));
  }
  private async isAllowedHybrid(ip: string): Promise<boolean> {
    let limit = this.maxRequests;
    if (this.softLimitPolicy){
      const localLoad = this.getCurrentLoadMemory(ip);
      limit = this.softLimitPolicy.effectiveLimit(localLoad);
    }
    const localLoad = this.getCurrentLoadMemory(ip);
    if (localLoad >= limit){
      return false;
    }
    const allowed = await this.checkRedis(ip, limit, this.windowMs);
    if (allowed){
      this.checkMemory(ip, limit, this.windowMs);
    }
    return allowed;
  }

  private async isAllowedMultiDimensionHybrid(
    ip: string,
    context: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): Promise<boolean> {
    const dimensions = this.multiDimensionPolicy!.getDimensions();

    for(const d of dimensions){
      const val = this.getDimensionValue(d, ip, context);
      if(val === undefined) continue;
      const key = this.multiDimensionPolicy!.buildKey(d.dimension, val, context.route ?? '');
      let limit = d.maxRequests;
      if(this.softLimitPolicy){
        limit = this.softLimitPolicy.effectiveLimit(this.getCurrentLoadMemory(key));
      }
      if(this.getCurrentLoadMemory(key) >= limit){
        return false;
      }
    }
    for(const d of dimensions){
      const val = this.getDimensionValue(d, ip, context);
      if(val === undefined) continue;
      const key = this.multiDimensionPolicy!.buildKey(d.dimension, val, context.route ?? '');
      let limit = d.maxRequests;
      if(this.softLimitPolicy){
        limit = this.softLimitPolicy.effectiveLimit(await this.getCurrentLoadRedis(key));
      }
      const allowed = await this.checkRedis(key, limit, d.windowMs);
      if(!allowed) return false;
      this.checkMemory(key, limit, d.windowMs);
    }
    return true;
  }

  private isAllowedMemory(ip: string): boolean {
    let limit = this.maxRequests;
    if(this.softLimitPolicy){
      const load = this.getCurrentLoadMemory(ip);
      limit = this.softLimitPolicy.effectiveLimit(load);
    }
    return this.checkMemory(ip, limit, this.windowMs);
  }

  private async isAllowedRedis(ip: string): Promise<boolean> {
    let limit = this.maxRequests;
    if(this.softLimitPolicy){
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
    for(const d of dimensions){
      const val = this.getDimensionValue(d, ip, context);
      if(val === undefined) continue;
      const key = this.multiDimensionPolicy!.buildKey(d.dimension, val, context.route ?? '');
      let limit = d.maxRequests;
      if(this.softLimitPolicy){
        const load = this.getCurrentLoadMemory(key);
        limit = this.softLimitPolicy.effectiveLimit(load);
      }
      const allowed = this.checkMemory(key, limit, d.windowMs);
      if(!allowed) return false;
    }
    return true;
  }

  private async isAllowedMultiDimensionRedis(
    ip: string,
    context: { apiKey?: string; route?: string; headers?: Record<string, string | string[] | undefined> }
  ): Promise<boolean> {
    const dimensions = this.multiDimensionPolicy!.getDimensions();
    for(const d of dimensions){
      const val = this.getDimensionValue(d, ip, context);
      if(val === undefined) continue;
      const key = this.multiDimensionPolicy!.buildKey(d.dimension, val, context.route ?? '');
      let limit = d.maxRequests;
      if(this.softLimitPolicy){
        const load = await this.getCurrentLoadRedis(key);
        limit = this.softLimitPolicy.effectiveLimit(load);
      }
      const allowed = await this.checkRedis(key, limit, d.windowMs);
      if(!allowed) return false;
    }
    return true;
  }

  private checkMemory(key: string, limit: number, windowMs: number): boolean {
    switch (this.algorithm){
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

    switch (this.algorithm){
      case "fixed-window": {
        return (await this.evalRedisRateLimitScript(
          REDIS_RATE_LIMIT_SCRIPTS.fixedWindow,
          [redisKey],
          [limit, windowMs],
        )) === 1;
      }

      case "sliding-window-log": {
        return (await this.evalRedisRateLimitScript(
          REDIS_RATE_LIMIT_SCRIPTS.slidingWindowLog,
          [redisKey, `${redisKey}:seq`],
          [limit, now, windowMs],
        )) === 1;
      }

      case "sliding-window-counter": {
        return (await this.evalRedisRateLimitScript(
          REDIS_RATE_LIMIT_SCRIPTS.slidingWindowCounter,
          [redisKey],
          [limit, now, windowMs],
        )) === 1;
      }

      case "token-bucket": {
        return (await this.evalRedisRateLimitScript(
          REDIS_RATE_LIMIT_SCRIPTS.tokenBucket,
          [redisKey],
          [limit, now, windowMs],
        )) === 1;
      }

      case "leaking-bucket": {
        return (await this.evalRedisRateLimitScript(
          REDIS_RATE_LIMIT_SCRIPTS.leakingBucket,
          [redisKey],
          [limit, now, windowMs],
        )) === 1;
      }

      default:
        return true;
    }
  }

  private async evalRedisRateLimitScript(
    script: string,
    keys: string[],
    args: number[],
  ): Promise<number> {
    const result = await this.redisClient!.eval(script, {
      keys,
      arguments: args.map(String),
    });
    return typeof result === "number" ? result : Number(result);
  }

  private getCurrentLoadMemory(key: string): number {
    const now = Date.now();
    switch (this.algorithm){
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
      switch (this.algorithm){
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
          if(!state || !state.currentCount) return 0;
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
    switch (d.dimension){
      case "ip":
        return ip;
      case "api-key":
        return context.apiKey;
      case "route":
        return context.route;
      case "header":
        if(d.headerName){
          const raw = context.headers?.[d.headerName.toLowerCase()];
          return Array.isArray(raw) ? raw[0] : raw;
        }
        return undefined;
      default:
        return undefined;
    }
  }
}
