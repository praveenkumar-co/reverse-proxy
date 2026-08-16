import type { ICircuitBreaker } from "./contracts/circuit-breaker.interface.js";

export class AdaptiveCircuitBreaker implements ICircuitBreaker {
  private requests = 0;
  private accepts = 0;

  constructor(
    private K = 2,
    private decayFactor = 0.9,
  ) {}

  public recordSuccess(latencyMs: number) {
    this.requests = this.requests * this.decayFactor + 1;
    this.accepts = this.accepts * this.decayFactor + 1;
  }

  public recordFailure() {
    this.requests = this.requests * this.decayFactor + 1;
    this.accepts = this.accepts * this.decayFactor;
  }

  public isAllowed(): boolean {
    const dropProbability = Math.max(0, (this.requests - this.K * this.accepts) / (this.requests + 1));
    if (dropProbability > 0) {
      return Math.random() >= dropProbability;
    }
    return true;
  }

  public getStats() {
    return {
      requests: this.requests,
      accepts: this.accepts,
      dropProbability: Math.max(0, (this.requests - this.K * this.accepts) / (this.requests + 1)),
    };
  }
}
