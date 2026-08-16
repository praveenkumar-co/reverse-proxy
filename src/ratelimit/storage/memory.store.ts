import type { IRateLimitStore } from '../contracts/storage.interface.js';

export class MemoryStore implements IRateLimitStore {
  private counts = new Map<string, { count: number; resetTime: number }>();

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const data = this.counts.get(key);
    if (!data || now >= data.resetTime) {
      this.counts.set(key, { count: 1, resetTime: now + windowMs });
      return 1;
    }
    data.count++;
    return data.count;
  }

  async count(key: string): Promise<number> {
    return this.counts.get(key)?.count ?? 0;
  }

  async reset(key: string): Promise<void> {
    this.counts.delete(key);
  }
}
