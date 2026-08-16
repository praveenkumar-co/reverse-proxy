export interface IBalancer {
  pickFiltered(healthyIds: Set<string>, clientIp?: string, attemptedIds?: Set<string>, cookies?: string): string | null;
  recordSuccess(id: string, latencyMs?: number): void;
  recordFailure(id: string): void;
  setHealthy(id: string, healthy: boolean): void;
  getStats(): Record<string, any>;
}
