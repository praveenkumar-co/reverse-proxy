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
  async invalidate(pattern: string): Promise<number> {
    const searchPatterns = pattern.includes("*")
      ? [pattern, `*${pattern}*`, `proxy:*:${pattern}`]
      : [`proxy:*:${pattern}`, `*${pattern}*`];
    const allKeys = new Set<string>();
    for(const p of searchPatterns){
      try {
        // KEYS is O(N) over the whole keyspace and blocks Redis for every other client while
        // it runs. scanIterator cursors through in small batches instead, so Redis stays
        // responsive to concurrent tenants during a large purge.
        for await (const batch of this.client.scanIterator({ MATCH: p, COUNT: 500 })){
          for (const key of batch) allKeys.add(key);
        }
      } catch {
        // ignore individual pattern failures
      }
    }
    if (allKeys.size > 0){
      const keys = [...allKeys];
      const BATCH_SIZE = 500;
      for (let i = 0; i < keys.length; i += BATCH_SIZE){
        try {
          // UNLINK reclaims memory on a background thread instead of blocking Redis's single
          // command loop the way DEL does for large values. Issued per-key within the batch
          // (concurrently) rather than as one variadic command, which keeps each request small.
          await Promise.all(keys.slice(i, i + BATCH_SIZE).map((k) => this.client.unlink(k)));
        } catch {
          // ignore individual batch failures
        }
      }
    }
    return allKeys.size;
  }

  buildKey(method: string, path: string): string {
    return `proxy:${method}:${path}`;
  }
}
