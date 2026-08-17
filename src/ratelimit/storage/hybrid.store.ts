import type { IRateLimitStore } from '../contracts/storage.interface.js';
import { MemoryStore } from './memory.store.js';

export class HybridStore implements IRateLimitStore {
  private memory = new MemoryStore();
  constructor(private remote: IRateLimitStore) {}

  async increment(key: string, windowMs: number): Promise<number> {
    const localCount = await this.memory.count(key);
    if (localCount > 0) {
      const nextVal = await this.memory.increment(key, windowMs);
      this.remote.increment(key, windowMs).catch(() => {});
      return nextVal;
    }

    try {
      const remoteCount = await this.remote.count(key);
      if (remoteCount > 0) {
        await this.memory.reset(key);
        for (let i = 0; i < remoteCount; i++) {
          await this.memory.increment(key, windowMs);
        }
        const nextVal = await this.memory.increment(key, windowMs);
        await this.remote.increment(key, windowMs);
        return nextVal;
      }
    } catch {
      // Graceful degradation to memory-only
    }

    const nextVal = await this.memory.increment(key, windowMs);
    await this.remote.increment(key, windowMs).catch(() => {});
    return nextVal;
  }

  async count(key: string): Promise<number> {
    const localCount = await this.memory.count(key);
    if (localCount > 0) return localCount;

    try {
      const remoteCount = await this.remote.count(key);
      if (remoteCount > 0) {
        await this.memory.reset(key);
        for (let i = 0; i < remoteCount; i++) {
          await this.memory.increment(key, 60000);
        }
        return remoteCount;
      }
    } catch {
      // Fallback to L1
    }
    return 0;
  }

  async reset(key: string): Promise<void> {
    await this.memory.reset(key);
    await this.remote.reset(key).catch(() => {});
  }
}
