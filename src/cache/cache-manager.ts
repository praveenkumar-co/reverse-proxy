import { createClient } from "redis";
import type { RedisClientType } from "redis";
import { logger } from "../observability/logger/logger.js";
import type { CacheConfig } from "./contracts/cache-config.interface.js";
import type { ICache } from "./contracts/cache.interface.js";
import { RedisCache } from "./stores/redis.cache.js";
import { HybridCache } from "./stores/hybrid.cache.js";
import { DebeziumInvalidator } from "./invalidation/debezium.invalidator.js";
import { KeyBuilder } from "./policies/key-builder.js";
import { parseCacheControl } from "./policies/cache-control.parser.js";
import { StaleWhileRevalidate } from "./policies/stale-while-revalidate.js";
import { StaleIfError } from "./policies/stale-if-error.js";
import { TagInvalidator } from "./invalidation/tag.invalidator.js";
import { PatternInvalidator } from "./invalidation/pattern.invalidator.js";

export class Cache {
  private client!: RedisClientType;
  private subClient?: RedisClientType;
  private store!: ICache;
  private invalidator?: DebeziumInvalidator;
  private ttlSeconds: number;
  private enabled: boolean;
  private config: CacheConfig;
  private connected = false;
  private keyBuilder: KeyBuilder;
  private tagInvalidator = new TagInvalidator();
  private patternInvalidator: PatternInvalidator;
  private staleWhileRevalidate = new StaleWhileRevalidate();
  private staleIfError = new StaleIfError();

  constructor(config: CacheConfig){
    this.config = config;
    this.ttlSeconds = config.ttlSeconds;
    this.enabled = config.enabled;
    this.keyBuilder = new KeyBuilder({
      ignoreQueryParams: config.key?.ignoreQueryParams,
      varyHeaders: config.key?.varyHeaders,
      prefix: "proxy",
    });
    this.patternInvalidator = new PatternInvalidator({ invalidate: (pattern) => this.invalidate(pattern) });
    this.client = createClient({
      socket: {
        host: config.host,
        port: config.port,
        reconnectStrategy: (retries) => {
          if(retries > 5){
            logger.error("Cache", `Redis reconnect failed after ${retries} attempts`);
            return new Error("Redis reconnect failed");
          }
          return retries * 500;
        },
      },
    }) as RedisClientType;
    this.client.on("error", (err) => {
      logger.error("Cache", `Redis error: ${err.message}`);
      this.connected = false;
    });

    this.client.on("connect", () => {
      logger.info("Cache", `Redis connected at ${config.host}:${config.port}`);
      this.connected = true;
    });
    this.client.on("reconnecting", () => {
      logger.warn("Cache", "Redis reconnecting");
    });
    const redisStore = new RedisCache(this.client, this.ttlSeconds);
    if(config.l1Enabled !== false){
      this.store = new HybridCache(
        redisStore,
        config.l1MaxSize ?? 1000,
        this.ttlSeconds,
      );
    }else {
      this.store = redisStore;
    }
  }

  public getClient(): RedisClientType {
    return this.client;
  }

  async connect(): Promise<void> {
    if(!this.enabled){
      logger.info("Cache", "Caching disabled — skipping Redis connection");
      return;
    }
    try {
      await this.client.connect();
      this.connected = true;

      if(this.config.debezium?.enabled){
        await this.setupDebeziumSubscriber();
      }
    } catch (err: any){
      logger.error("Cache", `Failed to connect to Redis: ${err.message}`);
      this.connected = false;
    }
  }
  private async setupDebeziumSubscriber(): Promise<void> {
    const dbzConfig = this.config.debezium!;
    try {
      this.subClient = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
        },
      }) as RedisClientType;

      this.subClient.on("error", (err) => {
        logger.error("Cache", `Debezium subscriber Redis error: ${err.message}`);
      });

      await this.subClient.connect();
      logger.info(
        "Cache",
        `Debezium subscriber connected, listening on channel: ${dbzConfig.channel}`,
      );
      this.invalidator = new DebeziumInvalidator(
        dbzConfig.mappings ?? [],
        (pattern) => this.invalidate(pattern),
      );

      await this.subClient.subscribe(dbzConfig.channel, async (message) => {
        try {
          await this.invalidator!.handle(message);
        } catch (err: any){
          logger.error("Cache", `Debezium handle failed: ${err.message}`);
        }
      });
    } catch (err: any){
      logger.error("Cache", `Failed to setup Debezium subscriber: ${err.message}`);
    }
  }

  /**
   * Builds the cache key via KeyBuilder — honors configured ignoreQueryParams and
   * varyHeaders (e.g. Accept, Accept-Encoding) instead of naive method+path concatenation.
   */
  buildKey(method: string, url: string, headers: Record<string, string | string[] | undefined> = {}): string {
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") normalizedHeaders[k] = v;
      else if (Array.isArray(v)) normalizedHeaders[k] = v.join(",");
    }
    return this.keyBuilder.build(method, url, normalizedHeaders);
  }

  /**
   * Decides, from an upstream response's Cache-Control header, whether the response may be
   * stored at all — honors no-store/no-cache/private rather than the caller doing its own
   * substring checks.
   */
  isResponseCacheable(headers: Record<string, any> | undefined): boolean {
    const raw = headers?.["cache-control"];
    if (!raw) return true;
    const header = Array.isArray(raw) ? raw.join(",") : String(raw);
    const directives = parseCacheControl(header);
    return !directives.noStore && !directives.noCache && !directives.private;
  }

  async get(key: string): Promise<string | null> {
    if(!this.enabled) return null;
    try {
      const value = await this.store.get(key);
      if(value){
        logger.info("Cache", `HIT → ${key}`);
      }
      else {
        logger.info("Cache", `MISS → ${key}`);
      }
      return value;
    } catch (err: any){
      logger.error("Cache", `GET error: ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlOverride?: number, tags?: string[]): Promise<void> {
    if(!this.enabled) return;
    const ttl = ttlOverride ?? this.ttlSeconds;
    try {
      await this.store.set(key, value, ttl);
      if (tags && tags.length > 0) {
        this.tagInvalidator.tag(key, tags);
      }
      logger.info("Cache", `SET → ${key}`, { ttl, tags });
    } catch (err: any){
      logger.error("Cache", `SET error: ${err.message}`);
    }
  }

  async del(key: string): Promise<void> {
    if(!this.enabled) return;
    try {
      await this.store.del(key);
    } catch (err: any){
      logger.error("Cache", `DEL error: ${err.message}`);
    }
  }

  async invalidate(pattern: string): Promise<void> {
    if(!this.enabled) return;
    try {
      await this.store.invalidate(pattern);
      logger.info("Cache", `INVALIDATED pattern`, { pattern });
    } catch (err: any){
      logger.error("Cache", `INVALIDATE error: ${err.message}`);
    }
  }

  /** Evicts every key previously tagged (via set()'s `tags` param) with the given tag. */
  async purgeByTag(tag: string): Promise<string[]> {
    const keys = this.tagInvalidator.getKeysForTag(tag);
    await Promise.all(keys.map((k) => this.del(k)));
    this.tagInvalidator.removeTag(tag);
    logger.info("Cache", `PURGED by tag`, { tag, count: keys.length });
    return keys;
  }

  /** Wildcard/pattern-based purge (e.g. "/api/users/*"). */
  async purgeByPattern(pattern: string): Promise<void> {
    await this.patternInvalidator.invalidate(pattern);
  }

  /** Stale-while-revalidate: whether a stale entry should be served + a background refresh kicked off. */
  shouldRevalidate(key: string, ageSeconds: number, maxAgeSeconds: number): boolean {
    if (this.config.staleWhileRevalidate === false) return false;
    return this.staleWhileRevalidate.shouldRevalidate(key, ageSeconds, maxAgeSeconds);
  }
  markRevalidating(key: string): void {
    this.staleWhileRevalidate.markRevalidating(key);
  }
  markRevalidationDone(key: string): void {
    this.staleWhileRevalidate.markDone(key);
  }

  /** Stale-if-error: whether a stale entry may be served in place of the given upstream error. */
  shouldServeStaleOnError(errorStatus: number, ageSeconds: number): boolean {
    if (this.config.staleIfError === false) return false;
    const window = this.config.staleIfErrorSeconds ?? 86400;
    return this.staleIfError.shouldServeStale(errorStatus, window, ageSeconds);
  }

  async disconnect(): Promise<void> {
    if(this.connected){
      try {
        if(this.subClient){
          await this.subClient.quit();
        }
        await this.client.quit();
      } catch {}
      this.connected = false;
      logger.info("Cache", "Redis disconnected");
    }
  }

  isConnected(): boolean {
    return !this.enabled || this.connected;
  }

  getStats(): object {
    return {
      enabled: this.enabled,
      connected: this.connected,
      ttlSeconds: this.ttlSeconds,
      l1Enabled: this.config.l1Enabled !== false,
      l1MaxSize: this.config.l1MaxSize ?? 1000,
      debeziumEnabled: this.config.debezium?.enabled ?? false,
    };
  }

  async handleDebeziumEvent(eventJson: string): Promise<void> {
    if(!this.invalidator){
      this.invalidator = new DebeziumInvalidator(
        this.config.debezium?.mappings ?? [],
        (pattern) => this.invalidate(pattern),
      );
    }
    await this.invalidator.handle(eventJson);
  }
}
