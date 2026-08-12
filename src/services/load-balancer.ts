import { logger } from "../middleware/logger.js";
import { registry } from "./registry.js";

export type LBStrategy =
  | "round-robin"
  | "weighted-round-robin"
  | "least-connections"
  | "weighted-least-connections"
  | "least-response-time"
  | "random"
  | "ip-hash"
  | "consistent-hashing"
  | "least-bandwidth"
  | "resource-based"
  | "sticky-sessions";

interface UpstreamState {
  id: string;
  activeConnections: number;
  failures: number;
  lastFailureTime: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  weight: number;
  currentWeight: number;
  effectiveWeight: number;
  responseTime: number; 
  totalBytes: number;   
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
    for(const u of config.upstreams) {
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
        responseTime: 0,
        totalBytes: 0,
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
      responseTime: 0,
      totalBytes: 0,
    });
  }
  removeUpstream(id: string): void {
    this.states.delete(id);
    this.staticWeights.delete(id);
  }
  hasUpstream(id: string): boolean {
    return this.states.has(id);
  }
  recordSuccess(id: string, latencyMs?: number, bytes?: number): void {
    const s = this.states.get(id);
    if(!s) return;
    if(s.state === "HALF_OPEN") {
      logger.info("CircuitBreaker", `${id} HALF_OPEN succeeded → CLOSED`);
    } else {
      logger.info("CircuitBreaker", `${id} → CLOSED`);
    }
    s.failures = 0;
    s.state = "CLOSED";
    if (s.effectiveWeight < s.weight) {
      s.effectiveWeight++;
    }
    if (latencyMs !== undefined) {
      s.responseTime = s.responseTime === 0 ? latencyMs : s.responseTime * 0.9 + latencyMs * 0.1;
    }
    if (bytes !== undefined) {  
      s.totalBytes += bytes;
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
    logger.info("CircuitBreaker", `${id} failure count = ${s.failures}`, { id });
    if (s.activeConnections > 0) s.activeConnections--;
    if (s.failures >= this.failureThreshold) {
      s.state = "OPEN";
      logger.warn("CircuitBreaker", `${id} → OPEN`, { id, failures: s.failures });
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
          logger.info("CircuitBreaker", `${s.id} → HALF_OPEN`);
          available.push(s);
        } else {
          logger.warn("CircuitBreaker", `${s.id} is OPEN — skipping`, { id: s.id });
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
    attemptedUpstreams: Set<string> = new Set(),
    cookieHeader?: string,
  ): string | null {
    const allAvailable = this.getAvailable(healthyIds);
    const available = allAvailable.filter(
      (s) => !attemptedUpstreams.has(s.id),
    );

    if (available.length === 0) return null;
    let chosen: UpstreamState = available[0]!;

    switch (this.strategy) {
      case "round-robin": {
        chosen = available[this.rrIndex % available.length]!;
        this.rrIndex = (this.rrIndex + 1) % 1000000; // prevent overflow
        break;
      }
      case "least-connections": {
        chosen = available.reduce((a, b) =>
          a.activeConnections <= b.activeConnections ? a : b,
        );
        break;
      }
      case "weighted-least-connections": {
        chosen = available.reduce((a, b) => {
          const wA = a.weight || 1;
          const wB = b.weight || 1;
          return a.activeConnections / wA <= b.activeConnections / wB ? a : b;
        });
        break;
      }
      case "least-response-time": {
        chosen = available.reduce((a, b) =>
          a.responseTime <= b.responseTime ? a : b,
        );
        break;
      }
      case "ip-hash": {
        const hash = this.hashIp(clientIp ?? "0.0.0.0");
        chosen = available[hash % available.length]!;
        break;
      }
      case "consistent-hashing": {
        const ring: Array<{ hash: number; state: UpstreamState }> = [];
        const virtualNodeReplicas = 40;

        for (const s of available) {
          for (let i = 0; i < virtualNodeReplicas; i++) {
            const nodeHash = this.hashString(`${s.id}-replica-${i}`);
            ring.push({ hash: nodeHash, state: s });
          }
        }
        ring.sort((a, b) => a.hash - b.hash);
        const clientHash = this.hashString(clientIp ?? "0.0.0.0");
        let index = ring.findIndex((node) => node.hash >= clientHash);
        if (index === -1) {
          index = 0;
        }
        chosen = ring[index]?.state ?? available[0]!;
        break;
      }
      case "least-bandwidth": {
        chosen = available.reduce((a, b) =>
          a.totalBytes <= b.totalBytes ? a : b,
        );
        break;
      }
      case "resource-based": {
        chosen = available.reduce((a, b) => {
          const scoreA = this.getResourceScore(a.id);
          const scoreB = this.getResourceScore(b.id);
          return scoreA <= scoreB ? a : b;
        });
        break;
      }

      case "sticky-sessions": {
        if (cookieHeader) {
          const cookies = this.parseCookies(cookieHeader);
          const stickId = cookies["NINJA_ROUTE"];
          if (stickId && healthyIds.has(stickId) && !attemptedUpstreams.has(stickId)) {
            const matched = available.find((s) => s.id === stickId);
            if (matched) {
              chosen = matched;
              break;
            }
          }
        }
        // Fall back to unweighted least connections if session cookie isnot present or healthy 
        chosen = available.reduce((a, b) =>
          a.activeConnections <= b.activeConnections ? a : b,
        );
        break;
      }

      case "random": {
        chosen = available[Math.floor(Math.random() * available.length)]!;
        break;
      }

      case "weighted-round-robin":
      default: {
        // Smooth Weighted Round Robin
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

  private hashString(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      // FNV-1a multiplication
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }

  private getResourceScore(upstreamId: string): number {
    const instance = registry.get(upstreamId);
    if (!instance || !instance.metadata) {
      return 0.5; // Neutral balance factor if no resource metrics are registered
    }
    const cpu = parseFloat(instance.metadata["cpu"] ?? "0.5");
    const memory = parseFloat(instance.metadata["memory"] ?? "0.5");
    // Weighted resource index: 70% CPU, 30% Memory
    return (cpu * 0.7) + (memory * 0.3);
  }

  private parseCookies(cookieHeader: string): Record<string, string> {
    const list: Record<string, string> = {};
    cookieHeader.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      if (parts[0]) {
        list[parts[0].trim()] = parts.slice(1).join("=").trim();
      }
    });
    return list;
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
        responseTimeMs: Math.round(s.responseTime),
        totalBytes: s.totalBytes,
        resourceScore: this.getResourceScore(id),
      };
    }
    return out;
  }
}