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
  weight: number;
  currentWeight: number;
  effectiveWeight: number;
}

interface LoadBalancerConfig {
  strategy: LBStrategy;
  upstreams: Array<{ id: string; weight?: number }>;
  failureThreshold?: number;
  recoveryTimeMs?: number;
}

export class LoadBalancer {
  private states: Map<string, UpstreamState> = new Map();
  private strategy: LBStrategy;
  private rrIndex: number = 0;
  private failureThreshold: number;
  private recoveryTimeMs: number;
  private staticWeights: Map<string, number> = new Map();

  constructor(config: LoadBalancerConfig) {
    this.strategy = config.strategy;
    this.failureThreshold = config.failureThreshold ?? 3;
    this.recoveryTimeMs = config.recoveryTimeMs ?? 15000;

    for (const u of config.upstreams) {
      const weight = u.weight ?? 1;
      this.staticWeights.set(u.id, weight);
      this.states.set(u.id, {
        id: u.id,
        activeConnections: 0,
        failures: 0,
        lastFailureTime: 0,
        state: "CLOSED",
        weight: weight,
        currentWeight: 0,
        effectiveWeight: weight,
      });
    }
  }

  addUpstream(id: string, weight = 1): void {
    if (this.states.has(id)) return;
    this.staticWeights.set(id, weight);
    this.states.set(id, {
      id,
      activeConnections: 0,
      failures: 0,
      lastFailureTime: 0,
      state: "CLOSED",
      weight: weight,
      currentWeight: 0,
      effectiveWeight: weight,
    });
  }

  removeUpstream(id: string): void {
    this.states.delete(id);
    this.staticWeights.delete(id);
  }

  hasUpstream(id: string): boolean {
    return this.states.has(id);
  }

  recordSuccess(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.failures = 0;
    s.state = "CLOSED";
    if (s.effectiveWeight < s.weight) {
      s.effectiveWeight++;
    }
    if (s.activeConnections > 0) s.activeConnections--;
  }

  recordFailure(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.failures++;
    s.lastFailureTime = Date.now();
    if (s.effectiveWeight > 1) {
      s.effectiveWeight--;
    }
    if (s.activeConnections > 0) s.activeConnections--;
    if (s.failures >= this.failureThreshold) {
      s.state = "OPEN";
    }
  }

  private getAvailable(healthyIds: Set<string>): UpstreamState[] {
    const now = Date.now();
    const available: UpstreamState[] = [];
    for (const [, s] of this.states) {
      if (!healthyIds.has(s.id)) continue;
      if (s.state === "OPEN") {
        if (now - s.lastFailureTime >= this.recoveryTimeMs) {
          s.state = "HALF_OPEN";
          available.push(s);
        }
        continue;
      }
      available.push(s);
    }
    return available;
  }

  pick(healthyIds: Set<string>, clientIp?: string): string | null {
    return this.pickFiltered(healthyIds, clientIp, new Set());
  }

  pickFiltered(
    healthyIds: Set<string>,
    clientIp?: string,
    attemptedUpstreams: Set<string> = new Set()
  ): string | null {
    const allAvailable = this.getAvailable(healthyIds);
    const available = allAvailable.filter((s) => !attemptedUpstreams.has(s.id));
    
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
        chosen = available[hash % available.length]!;
        break;
      }
      case "random": {
        chosen = available[Math.floor(Math.random() * available.length)]!;
        break;
      }
      case "round-robin":
      default: {
        let totalEffectiveWeight = 0;
        let best: UpstreamState | null = null;

        for (const s of available) {
          s.currentWeight += s.effectiveWeight;
          totalEffectiveWeight += s.effectiveWeight;
          if (!best || s.currentWeight > best.currentWeight) {
            best = s;
          }
        }
        if (best) {
          best.currentWeight -= totalEffectiveWeight;
          chosen = best;
        }
        break;
      }
    }
    chosen.activeConnections++;
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
        weight: s.weight,
        effectiveWeight: s.effectiveWeight,
      };
    }
    return out;
  }
}