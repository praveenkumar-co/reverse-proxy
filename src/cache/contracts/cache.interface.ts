export interface ICache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  invalidate(pattern: string): Promise<void>;
  buildKey(method: string, path: string): string;
}
