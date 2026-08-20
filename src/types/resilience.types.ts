import type { ICircuitBreaker } from '../resilience/circuit-breaker/contracts/circuit-breaker.interface.js';
import type { IRetryPolicy } from '../resilience/retry/contracts/retry.interface.js';

export type CircuitBreakerMode = 'classic' | 'adaptive';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type RetryBackoffStrategy =
  | 'exponential'
  | 'full-jitter'
  | 'equal-jitter'
  | 'decorrelated-jitter';

export interface ClassicCircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeMs: number;
}
export interface AdaptiveCircuitBreakerOptions {
  K: number;
  decayFactor?: number;
}

export type CircuitBreakerOptions = ClassicCircuitBreakerOptions | AdaptiveCircuitBreakerOptions;

export interface RetryConfig {
  backoff: RetryBackoffStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  budgetPercent: number;
}
export namespace ResilienceTypes {
  export type CBMode = CircuitBreakerMode;
  export type CBState = CircuitBreakerState;
  export type BackoffStrategy = RetryBackoffStrategy;
  export type CBOptions = CircuitBreakerOptions;
  export type RetryOptions = RetryConfig;
  export type CircuitBreaker = ICircuitBreaker;
  export type RetryPolicy = IRetryPolicy;
}
