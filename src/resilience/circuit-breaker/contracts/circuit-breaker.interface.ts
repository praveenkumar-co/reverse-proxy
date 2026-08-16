export interface ICircuitBreaker {
  recordSuccess(latencyMs: number): void;
  recordFailure(): void;
  isAllowed(): boolean;
}
