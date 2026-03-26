import { createClient } from "redis";
import type { RedisClientType } from "redis";

export interface CacheConfig {
  host: string;
  port: number;
  ttlSeconds: number;
  enabled: boolean;
}

export class Cache {
  private client!: RedisClientType;
  private ttlSeconds: number;
  private enabled: boolean;
  private connected: boolean = false;

  constructor(config: CacheConfig) {
    this.ttlSeconds = config.ttlSeconds;
    this.enabled = config.enabled;

    this.client = createClient({
      socket: {
        host: config.host,
        port: config.port,
        reconnectStrategy: (retries) => {
          if (retries > 5) {
            console.error(`[Cache] Redis reconnect failed after ${retries} attempts`);
            return new Error("Redis reconnect failed");
          }
          return retries * 500;
        },
      },
    }) as RedisClientType;

    this.client.on("error", (err) => {
      console.error(`[Cache] Redis error: ${err.message}`);
      this.connected = false;
    });

    this.client.on("connect", () => {
      console.log(`[Cache] Redis connected at ${config.host}:${config.port}`);
      this.connected = true;
    });

    this.client.on("reconnecting", () => {
      console.log(`[Cache] Redis reconnecting...`);
    });
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      console.log(`[Cache] Caching is disabled — skipping Redis connection`);
      return;
    }
    try {
      await this.client.connect();
      this.connected = true;
    } catch (err: any) {
      console.error(`[Cache] Failed to connect to Redis: ${err.message}`);
      this.connected = false;
    }
  }

  // Build a unique cache key from method + url
  buildKey(method: string, url: string): string {
    return `proxy:${method}:${url}`;
  }

  async get(key: string): Promise<string | null> {
    if (!this.enabled || !this.connected) return null;
    try {
      const value = await this.client.get(key);
      if (value) {
        console.log(`[Cache] HIT → ${key}`);
      } else {
        console.log(`[Cache] MISS → ${key}`);
      }
      return value;
    } catch (err: any) {
      console.error(`[Cache] GET error: ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.enabled || !this.connected) return;
    try {
      await this.client.set(key, value, { EX: this.ttlSeconds });
      console.log(`[Cache] SET → ${key} (TTL: ${this.ttlSeconds}s)`);
    } catch (err: any) {
      console.error(`[Cache] SET error: ${err.message}`);
    }
  }

  async invalidate(pattern: string): Promise<void> {
    if (!this.enabled || !this.connected) return;
    try {
      const keys = await this.client.keys(`proxy:*:${pattern}`);
      if (keys.length > 0) {
        await this.client.del(keys);
        console.log(`[Cache] INVALIDATED ${keys.length} keys for pattern: ${pattern}`);
      }
    } catch (err: any) {
      console.error(`[Cache] INVALIDATE error: ${err.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.disconnect();
      console.log(`[Cache] Redis disconnected`);
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
    };
  }
}