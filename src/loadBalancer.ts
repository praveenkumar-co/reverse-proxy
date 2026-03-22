export type LBStrategy =
  | "round-robin"
  | "least-connections"
  | "ip-hash"
  | "random";

interface UpstreamState {
  id: string;
  activeConnections: number;
  failures: number;
  lastFailureTime: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
}

interface LoadBalancerConfig {
  strategy: LBStrategy;
  upstreamIds: string[];
  failureThreshold?: number;
  recoveryTimeMs?: number;
}
export class LoadBalancer {
  private states: Map<string, UpstreamState> = new Map();
  private strategy: LBStrategy;
  private rrIndex: number = 0;
  private failureThreshold: number;
  private recoveryTimeMs: number;

  // in calss create constructor to get property
  constructor(config: LoadBalancerConfig) {
    this.strategy = config.strategy;
    this.failureThreshold = config.failureThreshold ?? 3; // since undefined declare it to 3
    this.recoveryTimeMs = config.recoveryTimeMs ?? 15000; // since undefined declare it to 15000

    for (const id of config.upstreamIds) {
      this.states.set(id, {
        id,
        activeConnections: 0,
        failures: 0,
        lastFailureTime: 0,
        state: "CLOSED",
      });
    }
  }
  addUpstream(id: string): void {
    if (this.states.has(id)) {
      return;
    }
    this.states.set(id, {
      id,
      activeConnections: 0,
      failures: 0,
      lastFailureTime: 0,
      state: "CLOSED",
    });
    console.log(`[LoadBalancer] Upstream ADDED: ${id}`);
  }
  removeUpstream(id: string): void {
    if (!this.states.has(id)) {
      return;
    }
    console.log(`[LB DEBUG] removeUpstream called for: ${id}`);
    this.states.delete(id);
    console.log(`[LoadBalancer] Upstream REMOVED: ${id}`);
  }
  hasUpstream(id: string): boolean {
    return this.states.has(id);
  }
  recordSuccess(id: string): void {
    const s = this.states.get(id);
    if (!s) {
      return;
    }
    s.failures = 0;
    s.state = "CLOSED";
    if (s.activeConnections > 0) {
      s.activeConnections--;
    }
  }
  recordFailure(id: string): void {
    const s = this.states.get(id);
    if (!s) {
      return;
    }
    s.failures++;
    s.lastFailureTime = Date.now();
    if (s.activeConnections > 0) {
      s.activeConnections--;
    }
    if (s.failures >= this.failureThreshold) {
      if (s.state !== "OPEN") {
        console.log(
          `[CircuitBreaker] OPEN for upstream: ${id} (${s.failures} failures)`
        );
      }
      s.state = "OPEN";
    }
  }
  private getAvailable(healthyIds: Set<string>): UpstreamState[] {
    const now = Date.now();
    // available having context of upstreamState
    const available: UpstreamState[] = [];
    for (const [, s] of this.states) {
      if (!healthyIds.has(s.id)) continue;
      // skipping unhealhy upstreams server
      if (s.state === "OPEN") {
        if (now - s.lastFailureTime >= this.recoveryTimeMs) {
          s.state = "HALF_OPEN";
          console.log(
            `[CircuitBreaker] HALF_OPEN for upstream: ${s.id} — probing...`
          );
          // pushing upstream in available
          available.push(s);
        }
        continue;
      }
      available.push(s);
    }
    return available;
  }
  pick(healthyIds: Set<string>, clientIp?: string): string | null {
    const available = this.getAvailable(healthyIds);
    if (available.length === 0) return null;
    let chosen: UpstreamState = available[0]!;
    switch (this.strategy) {
      case "least-connections": {
        chosen = available.reduce((a, b) =>
          a.activeConnections <= b.activeConnections ? a : b
        );
        break;
      }
      case "ip-hash": {
        const hash = this.hashIp(clientIp ?? "0.0.0.0");
        // most similar to round robin algorithm to assign client IP address to available server present
        chosen = available[hash % available.length]!;
        break;
      }
      case "random": {
        // ! represent 0th Index will never be Zero .
        chosen = available[Math.floor(Math.random() * available.length)]!;
        break;
      }
      case "round-robin":
      default: {
        chosen = available[this.rrIndex % available.length]!;
        this.rrIndex++;
        break;
      }
    }
    chosen.activeConnections++;
    console.log(
      `[LB] ${chosen.id} activeConnections: ${chosen.activeConnections}`
    );
    return chosen.id;
  }
  private hashIp(ip: string): number {
    let hash = 5381;
    for (let i = 0; i < ip.length; i++) {
      hash = (hash * 33) ^ ip.charCodeAt(i);
    }
    return Math.abs(hash);
  }
  getStats(): Record<string, object> {
    const out: Record<string, object> = {};
    for (const [id, s] of this.states) {
      out[id] = {
        state: s.state,
        activeConnections: s.activeConnections,
        failures: s.failures,
      };
    }
    return out;
  }
}
