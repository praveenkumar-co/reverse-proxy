import { ClassicCircuitBreaker } from './classic.circuit-breaker.js';
import { AdaptiveCircuitBreaker } from './adaptive.circuit-breaker.js';
import type { ICircuitBreaker } from './contracts/circuit-breaker.interface.js';

export class CircuitBreakerManager {
  private breakers = new Map<string, ICircuitBreaker>();

  getOrCreate(id: string, mode: 'classic' | 'adaptive' = 'classic', options?: any): ICircuitBreaker {
    if (!this.breakers.has(id)) {
      const cb = mode === 'adaptive'
        ? new AdaptiveCircuitBreaker(options?.K ?? 2, options?.decayFactor ?? 0.9)
        : new ClassicCircuitBreaker(options?.failureThreshold ?? 3, options?.recoveryTimeMs ?? 30000);
      this.breakers.set(id, cb);
    }
    return this.breakers.get(id)!;
  }

  get(id: string): ICircuitBreaker | undefined {
    return this.breakers.get(id);
  }

  clear() {
    this.breakers.clear();
  }
}

export const circuitBreakerManager = new CircuitBreakerManager();
