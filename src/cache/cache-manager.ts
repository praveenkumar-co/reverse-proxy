import { createClient } from "redis";
import type { RedisClientType } from "redis";
import { logger } from "../observability/logger/logger.js";
import type { CacheConfig } from "./contracts/cache-config.interface.js";
import type { ICache } from "./contracts/cache.interface.js";
import { RedisCache } from "./stores/redis.cache.js";
import { HybridCache } from "./stores/hybrid.cache.js";
import { DebeziumInvalidator } from "./invalidation/debezium.invalidator.js";

export class Cache {
  private client!: RedisClientType;
  private subClient?: RedisClientType;
  private store!: ICache;
  private invalidator?: DebeziumInvalidator;
  private ttlSeconds: number;
  private enabled: boolean;
  private config: CacheConfig;
  private connected = false;

  constructor(config: CacheConfig) {
    this.config = config;
    this.ttlSeconds = config.ttlSeconds;
    this.enabled = config.enabled;

    this.client = createClient({
      socket: {
        host: config.host,
        port: config.port,
        reconnectStrategy: (retries) => {
          if (retries > 5) {
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
    if (config.l1Enabled !== false) {
      this.store = new HybridCache(
        redisStore,
        config.l1MaxSize ?? 1000,
        this.ttlSeconds,
      );
    } else {
      this.store = redisStore;
    }
  }

  public getClient(): RedisClientType {
    return this.client;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      logger.info("Cache", "Caching disabled — skipping Redis connection");
      return;
    }
    try {
      await this.client.connect();
      this.connected = true;

      if (this.config.debezium?.enabled) {
        await this.setupDebeziumSubscriber();
      }
    } catch (err: any) {
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

      // Wire the already-existing modular invalidator
      this.invalidator = new DebeziumInvalidator(
        dbzConfig.mappings ?? [],
        (pattern) => this.invalidate(pattern),
      );

      await this.subClient.subscribe(dbzConfig.channel, async (message) => {
        try {
          await this.invalidator!.handle(message);
        } catch (err: any) {
          logger.error("Cache", `Debezium handle failed: ${err.message}`);
        }
      });
    } catch (err: any) {
      logger.error("Cache", `Failed to setup Debezium subscriber: ${err.message}`);
    }
  }

  buildKey(method: string, url: string): string {
    return this.store.buildKey(method, url);
  }

  async get(key: string): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const value = await this.store.get(key);
      if (value) {
        logger.info("Cache", `HIT → ${key}`);
      } else {
        logger.info("Cache", `MISS → ${key}`);
      }
      return value;
    } catch (err: any) {
      logger.error("Cache", `GET error: ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlOverride?: number): Promise<void> {
    if (!this.enabled) return;
    const ttl = ttlOverride ?? this.ttlSeconds;
    try {
      await this.store.set(key, value, ttl);
      logger.info("Cache", `SET → ${key}`, { ttl });
    } catch (err: any) {
      logger.error("Cache", `SET error: ${err.message}`);
    }
  }

  async invalidate(pattern: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.store.invalidate(pattern);
      logger.info("Cache", `INVALIDATED pattern`, { pattern });
    } catch (err: any) {
      logger.error("Cache", `INVALIDATE error: ${err.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        if (this.subClient) {
          await this.subClient.quit();
        }
        await this.client.quit();
      } catch {}
      this.connected = false;
      logger.info("Cache", "Redis disconnected");
    }
  }

  isConnected(): boolean {
    return this.connected;
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
}
