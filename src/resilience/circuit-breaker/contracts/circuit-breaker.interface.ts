export interface ICircuitBreaker {
  recordSuccess(latencyMs: number): void;
  recordFailure(): void;
  isAllowed(): boolean;
  /**
   * Releases a HALF_OPEN probe slot granted by isAllowed() for a request that never actually
   * reached the upstream (e.g. rejected locally by a bulkhead) — neutral by design: it must
   * NOT affect the failure count or trip/reset state, since the upstream was never contacted
   * and so was neither proven healthy nor unhealthy. Without this, a probe slot claimed by a
   * request that gets locally rejected before dispatch would never be released.
   */
  cancelProbe(): void;
}
