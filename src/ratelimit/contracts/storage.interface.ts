export interface IRateLimitStore {
  increment(key: string, windowMs: number): Promise<number>;
  count(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}
