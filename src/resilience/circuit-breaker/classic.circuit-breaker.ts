import type { ICircuitBreaker } from "./contracts/circuit-breaker.interface.js";

export class ClassicCircuitBreaker implements ICircuitBreaker {
  private failures = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private lastFailureTime = 0;

  constructor(
    private failureThreshold: number,
    private recoveryTimeMs: number,
  ) {}

  public recordSuccess(latencyMs: number) {
    this.failures = 0;
    this.state = "CLOSED";
  }

  public recordFailure() {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = "OPEN";
      this.lastFailureTime = Date.now();
    }
  }

  public isAllowed(): boolean {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }
    return true;
  }

  public getState() {
    return this.state;
  }

  public getFailures() {
    return this.failures;
  }
}
