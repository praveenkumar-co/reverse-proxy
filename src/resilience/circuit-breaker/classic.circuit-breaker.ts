import type { ICircuitBreaker } from "./contracts/circuit-breaker.interface.js";

export class ClassicCircuitBreaker implements ICircuitBreaker {
  private failures = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private lastFailureTime = 0;
  // Number of HALF_OPEN trial requests currently in flight (granted by isAllowed(), not yet
  // resolved by recordSuccess/recordFailure). Without this, every concurrent request would be
  // let through the instant the breaker half-opens, slamming a barely-recovering upstream with
  // full production traffic and likely re-tripping it immediately.
  private halfOpenProbesInFlight = 0;

  constructor(
    private failureThreshold: number,
    private recoveryTimeMs: number,
    private maxHalfOpenProbes: number = 1,
  ){}
  public recordSuccess(_latencyMs: number){
    if(this.state === "HALF_OPEN" && this.halfOpenProbesInFlight > 0){
      this.halfOpenProbesInFlight--;
    }
    this.failures = 0;
    this.state = "CLOSED";
  }
  public recordFailure(){
    if(this.state === "HALF_OPEN" && this.halfOpenProbesInFlight > 0){
      this.halfOpenProbesInFlight--;
    }
    this.failures++;
    if(this.failures >= this.failureThreshold){
      this.state = "OPEN";
      this.lastFailureTime = Date.now();
      this.halfOpenProbesInFlight = 0;
    }
  }
  public isAllowed(): boolean {
    if(this.state === "OPEN"){
      if(Date.now() - this.lastFailureTime >= this.recoveryTimeMs){
        this.state = "HALF_OPEN";
        this.halfOpenProbesInFlight = 1;
        return true;
      }
      return false;
    }
    if(this.state === "HALF_OPEN"){
      if(this.halfOpenProbesInFlight < this.maxHalfOpenProbes){
        this.halfOpenProbesInFlight++;
        return true;
      }
      return false;
    }
    return true;
  }
  public getState(){
    return this.state;
  }
  public getFailures(){
    return this.failures;
  }
}
