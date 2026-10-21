import type { IRetryPolicy } from "../contracts/retry.interface.js";
import { isMethodRetrySafe } from "../idempotency.js";
import { calculateFullJitterBackoff } from "../backoff/full-jitter.backoff.js";

export interface IdempotentRetryPolicyOptions {
  method: string;
  headers: Record<string, any>;
  allowMutatingRetries?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Reconciles RetryHandler with the same idempotency rule master.ts's IPC dispatch loop
 * enforces (see isMethodRetrySafe): a RetryHandler wrapping this policy will not retry a
 * non-idempotent request unless it carries an Idempotency-Key header or the caller has
 * explicitly opted in. Intended for any future call site that needs to retry a single
 * async operation directly (RetryHandler.execute(fn, maxAttempts)) — master.ts's own
 * dispatch loop is not such a call site: each retry attempt there re-runs upstream
 * selection via the load balancer and circuit breaker, which is a different shape of
 * operation than "redo this one function call," so it is deliberately left as its own
 * loop rather than forced through RetryHandler.
 */
export class IdempotentRetryPolicy implements IRetryPolicy {
  constructor(private options: IdempotentRetryPolicyOptions) {}

  shouldRetry(_attempt: number, _error?: Error): boolean {
    return isMethodRetrySafe(
      this.options.method,
      this.options.headers,
      this.options.allowMutatingRetries ?? false,
    );
  }

  getDelay(attempt: number): number {
    return calculateFullJitterBackoff(
      attempt,
      this.options.baseDelayMs ?? 100,
      this.options.maxDelayMs ?? 5000,
    );
  }
}
