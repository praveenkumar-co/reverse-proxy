import type { IRateLimitStore } from '../contracts/storage.interface.js';
import type { RedisClientType } from 'redis';

export class RedisStore implements IRateLimitStore {
  constructor(private client: RedisClientType) {}

  async increment(key: string, windowMs: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) await this.client.pExpire(key, windowMs);
    return count;
  }

  async count(key: string): Promise<number> {
    const val = await this.client.get(key);
    return val ? parseInt(val, 10) : 0;
  }

  async reset(key: string): Promise<void> {
    await this.client.del(key);
  }
}
