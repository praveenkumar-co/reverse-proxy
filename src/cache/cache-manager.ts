import { createClient } from "redis";
import type { RedisClientType } from "redis";
import { logger } from "../observability/logger/logger.js";
import type {
  DebeziumMapping,
  DebeziumConfig,
  CacheConfig,
  L1Entry
} from "./contracts/cache-config.interface.js";

export class Cache {
  private client!: RedisClientType;
  private subClient?: RedisClientType;
  private ttlSeconds: number;
  private enabled: boolean;
  private config: CacheConfig;
  private connected: boolean = false;

  private l1Cache = new Map<string, L1Entry>();
  private l1Keys: string[] = [];

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
      logger.info("Cache", `Debezium subscriber connected, listening on channel: ${dbzConfig.channel}`);

      await this.subClient.subscribe(dbzConfig.channel, async (message) => {
        await this.handleDebeziumEvent(message);
      });
    } catch (err: any) {
      logger.error("Cache", `Failed to setup Debezium subscriber: ${err.message}`);
    }
  }

  private async handleDebeziumEvent(message: string): Promise<void> {
    try {
      const event = JSON.parse(message);
      const table = event.source?.table ?? event.source?.collection ?? "";
      if (!table) return;

      const parseObj = (val: any) => {
        if (typeof val === "string") {
          try { return JSON.parse(val); } catch { return null; }
        }
        return val;
      };

      const before = parseObj(event.before);
      const after = parseObj(event.after);
      const patch = parseObj(event.patch);

      const getVal = (obj: any, keys: string[]): string | undefined => {
        if (!obj) return undefined;
        for (const k of keys) {
          if (obj[k] !== undefined) {
            const val = obj[k];
            if (val && typeof val === "object" && val["$oid"] !== undefined) {
              return String(val["$oid"]);
            }
            return String(val);
          }
        }
        return undefined;
      };

      const recordId =
        getVal(before, ["id", "_id"]) ??
        getVal(after, ["id", "_id"]) ??
        getVal(patch, ["id", "_id"]) ??
        getVal(event, ["id", "_id"]);

      if (!recordId) return;

      logger.info("Cache", `Debezium CDC change detected: table=${table}, id=${recordId}`);

      const mappings = this.config.debezium?.mappings ?? [];
      const matchedMappings = mappings.filter((m) => m.table === table);

      if (matchedMappings.length > 0) {
        for (const m of matchedMappings) {
          const resolvedPath = m.pathPattern.replace("{id}", recordId);
          await this.invalidate(resolvedPath);
        }
      } else {
        await this.invalidate(`*${table}*${recordId}*`);
        await this.invalidate(`*${recordId}*`);
      }
    } catch (err: any) {
      logger.error("Cache", `Debezium event parse failed: ${err.message}`);
    }
  }

  buildKey(method: string, url: string): string {
    return `proxy:${method}:${url}`;
  }

  async get(key: string): Promise<string | null> {
    if (!this.enabled) return null;

    const now = Date.now();
    if (this.config.l1Enabled) {
      const entry = this.l1Cache.get(key);
      if (entry) {
        if (now < entry.expiresAt) {
          logger.info("Cache", `L1 HIT → ${key}`);
          return entry.value;
        } else {
          // L1 Expired, evict
          this.l1Cache.delete(key);
          const idx = this.l1Keys.indexOf(key);
          if (idx !== -1) this.l1Keys.splice(idx, 1);
        }
      }
    }

    if (!this.connected) return null;

    try {
      const value = await this.client.get(key);
      if (value) {
        logger.info("Cache", `L2 HIT → ${key}`);
        if (this.config.l1Enabled) {
          this.setL1(key, value);
        }
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

    if (this.config.l1Enabled) {
      this.setL1(key, value, ttl);
    }

    if (!this.connected) return;

    try {
      await this.client.set(key, value, { EX: ttl });
      logger.info("Cache", `SET → ${key}`, { ttl });
    } catch (err: any) {
      logger.error("Cache", `SET error: ${err.message}`);
    }
  }

  private setL1(key: string, value: string, ttl: number = this.ttlSeconds) {
    const maxSize = this.config.l1MaxSize ?? 1000;
    const now = Date.now();

    // Size limit enforcement (FIFO eviction)
    if (this.l1Cache.size >= maxSize && !this.l1Cache.has(key)) {
      const oldestKey = this.l1Keys.shift();
      if (oldestKey) {
        this.l1Cache.delete(oldestKey);
      }
    }

    this.l1Cache.set(key, {
      value,
      expiresAt: now + ttl * 1000,
    });
    if (!this.l1Keys.includes(key)) {
      this.l1Keys.push(key);
    }
  }

  async invalidate(pattern: string): Promise<void> {
    if (!this.enabled) return;
    if (this.config.l1Enabled) {
      const escaped = pattern.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&").replace(/\\\*/g, ".*");
      const regex = new RegExp(`^proxy:.*:${escaped}$`);
      for (const k of this.l1Cache.keys()) {
        if (regex.test(k) || k.includes(pattern)) {
          this.l1Cache.delete(k);
          const idx = this.l1Keys.indexOf(k);
          if (idx !== -1) this.l1Keys.splice(idx, 1);
        }
      }
    }

    if (!this.connected) return;

    try {
      const keys = await this.client.keys(`proxy:*:${pattern}`);
      if (keys.length > 0) {
        await this.client.del(keys);
        logger.info("Cache", `INVALIDATED ${keys.length} keys`, { pattern });
      }
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
      l1Size: this.l1Cache.size,
      debeziumEnabled: this.config.debezium?.enabled ?? false,
    };
  }
}
