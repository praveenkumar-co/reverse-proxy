import type { IRateLimitStore } from '../contracts/storage.interface.js';
import { MemoryStore } from './memory.store.js';

export class HybridStore implements IRateLimitStore {
  private memory = new MemoryStore();
  constructor(private remote: IRateLimitStore) {}

  async increment(key: string, windowMs: number): Promise<number> {
    try {
      return await this.remote.increment(key, windowMs);
    } catch {
      return this.memory.increment(key, windowMs);
    }
  }

  async count(key: string): Promise<number> {
    try {
      return await this.remote.count(key);
    } catch {
      return this.memory.count(key);
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.remote.reset(key);
    } catch {
      await this.memory.reset(key);
    }
  }
}
