import type { ICache } from '../contracts/cache.interface.js';
import { InMemoryLRU } from './in-memory-lru.js';

export class HybridCache implements ICache {
  private l1: InMemoryLRU;
  constructor(private l2: ICache, l1MaxSize: number, private defaultTtl: number){
    this.l1 = new InMemoryLRU(l1MaxSize);
  }
  async get(key: string): Promise<string | null>{
    const l1val = this.l1.get(key);
    if(l1val !== null) return l1val;
    try {
      const l2val = await this.l2.get(key);
      if(l2val !== null) this.l1.set(key, l2val, this.defaultTtl);
      return l2val;
    } catch {
      return null;
    }
  }
  async set(key: string, value: string, ttlSeconds = this.defaultTtl): Promise<void> {
    this.l1.set(key, value, ttlSeconds);
    try {
      await this.l2.set(key, value, ttlSeconds);
    } catch {
      // Gracefully continue with L1 if L2 is unreachable
    }
  }
  async del(key: string): Promise<void> {
    this.l1.del(key);
    try {
      await this.l2.del(key);
    } catch {}
  }
  async invalidate(pattern: string): Promise<void> {
    this.l1.invalidatePattern(pattern);
    try {
      await this.l2.invalidate(pattern);
    } catch {}
  }
  buildKey(method: string, path: string): string {
    return this.l2.buildKey(method, path);
  }
}
