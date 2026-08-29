import type { IRetryPolicy } from './contracts/retry.interface.js';

export class RetryHandler {
  constructor(private policy: IRetryPolicy){}

  async execute<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++){
      try {
        return await fn();
      } catch (err: any){
        lastError = err;
        if (!this.policy.shouldRetry(attempt, err)) break;
        const delay = this.policy.getDelay(attempt);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}
