import type { ICache } from "../contracts/cache.interface.js";
import type { RedisClientType } from "redis";

export class RedisCache implements ICache {
  constructor(
    private client: RedisClientType,
    private defaultTtl: number,
  ){}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds = this.defaultTtl): Promise<void> {
    await this.client.set(key, value, { EX: ttlSeconds });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async invalidate(pattern: string): Promise<void> {
    const searchPatterns = pattern.includes("*")
      ? [pattern, `*${pattern}*`, `proxy:*:${pattern}`]
      : [`proxy:*:${pattern}`, `*${pattern}*`];

    const allKeys = new Set<string>();
    for (const p of searchPatterns){
      try {
        const keys = await this.client.keys(p);
        keys.forEach((k) => allKeys.add(k));
      } catch {
        // ignore individual pattern failures
      }
    }

    if (allKeys.size > 0){
      await this.client.del([...allKeys]);
    }
  }

  buildKey(method: string, path: string): string {
    return `proxy:${method}:${path}`;
  }
}
