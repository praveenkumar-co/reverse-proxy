export interface IRetryPolicy {
  shouldRetry(attempt: number, error?: Error): boolean;
  getDelay(attempt: number): number;
}
