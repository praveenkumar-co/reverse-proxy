import { logger } from "../../observability/logger/logger.js";
import type { UpstreamState } from "./upstream-state.js";
import type { LoadBalancerConfigType } from "../../config/schemas/balancer.schema.js";
import { registry } from '../../discovery/registry/dynamic.registry.js';

export interface LoadBalancerOptions {
  strategy: string;
  upstreams: any[];
  failureThreshold?: number;
  recoveryTimeMs?: number;
  virtualNodes?: number;
  ewmaAlpha?: number;
  stickyCookieName?: string;
  slowStartSeconds?: number;
}

export class LoadBalancer {
  private strategy: string;
  private failureThreshold: number;
  private recoveryTimeMs: number;
  private virtualNodes: number;
  private ewmaAlpha: number;
  private stickyCookieName: string;
  private slowStartSeconds: number;

  private states = new Map<string, UpstreamState>();
  private roundRobinIndex = 0;
  private hashRing: Array<{ hash: number; id: string }> = [];

  constructor(options: LoadBalancerOptions) {
    this.strategy = options.strategy;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.recoveryTimeMs = options.recoveryTimeMs ?? 15000;
    this.virtualNodes = options.virtualNodes ?? 150;
    this.ewmaAlpha = options.ewmaAlpha ?? 0.1;
    this.stickyCookieName = options.stickyCookieName ?? "NINJA_ROUTE";
    this.slowStartSeconds = options.slowStartSeconds ?? 30;

    for (const upstream of options.upstreams) {
      this.states.set(upstream.id, {
        id: upstream.id,
        weight: upstream.weight ?? 1,
        activeConnections: 0,
        failures: 0,
        state: "CLOSED",
        lastFailureTime: 0,
        responseTime: 10, // Initialize baseline EWMA response time
        healthy: true,
        requests: 0,
        accepts: 0,
        slowStartEndTime: 0,
        maxConnections: upstream.maxConnections,
        currentWeight: 0,
      } as UpstreamState);
    }

    if (this.strategy === "consistent-hashing") {
      this.rebuildHashRing();
    }
  }

  public setHealthy(id: string, healthy: boolean) {
    const s = this.states.get(id);
    if (s) {
      if (s.healthy !== healthy) {
        logger.info("LoadBalancer", `Upstream health changed: ${id} -> ${healthy ? "HEALTHY" : "UNHEALTHY"}`);
        s.healthy = healthy;
        if (healthy && s.state === "OPEN") {
          // Trigger slow start warm-up when health returns
          s.state = "HALF_OPEN";
          s.slowStartEndTime = Date.now() + this.slowStartSeconds * 1000;
        }
      }
    }
  }

  public incrementConnection(id: string) {
    const s = this.states.get(id);
    if (s) {
      s.activeConnections++;
    }
  }

  public releaseConnection(id: string) {
    const s = this.states.get(id);
    if (s && s.activeConnections > 0) {
      s.activeConnections--;
    }
  }

  private rebuildHashRing() {
    this.hashRing = [];
    for (const [id, s] of this.states.entries()) {
      for (let i = 0; i < this.virtualNodes; i++) {
        const hash = this.fnv1a(`${id}#vnode${i}`);
        this.hashRing.push({ hash, id });
      }
    }
    this.hashRing.sort((a, b) => a.hash - b.hash);
  }

  private fnv1a(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash;
  }

  private getResourceScore(id: string): number {
    const record = registry.get(id);
    if (record?.metadata) {
      const cpu = parseFloat(record.metadata['cpu'] ?? '0');
      const memory = parseFloat(record.metadata['memory'] ?? '0');
      return cpu * 0.7 + memory * 0.3;
    }
    return 0;
  }

  public recordSuccess(id: string, latencyMs = 0) {
    const s = this.states.get(id);
    if (!s) return;

    // Decayed Requests & Accepts for SRE Adaptive Throttling
    s.requests = s.requests * 0.9 + 1;
    s.accepts = s.accepts * 0.9 + 1;

    // EWMA Latency update
    s.responseTime = this.ewmaAlpha * latencyMs + (1 - this.ewmaAlpha) * s.responseTime;

    s.failures = 0;
    if (s.state === "OPEN" || s.state === "HALF_OPEN") {
      logger.info("CircuitBreaker", `${id} restored to CLOSED state`);
      s.state = "CLOSED";
      s.slowStartEndTime = 0;
      let totalWeight = 0;
      for (const [_, state] of this.states) {
        if (state.healthy && state.state !== "OPEN") {
          totalWeight += state.weight;
        }
      }
      s.currentWeight -= totalWeight;
    }
  }

  public recordFailure(id: string) {
    const s = this.states.get(id);
    if (!s) return;

    // Decayed Requests & Accepts for SRE Adaptive Throttling
    s.requests = s.requests * 0.9 + 1;
    s.accepts = s.accepts * 0.9; // fails don't count towards accepts

    s.failures++;
    if (s.failures >= this.failureThreshold) {
      if (s.state !== "OPEN") {
        logger.warn("CircuitBreaker", `${id} tripped to OPEN state`, { failures: s.failures });
        s.state = "OPEN";
        s.lastFailureTime = Date.now();
      }
    }
  }

  public pickFiltered(
    healthyIds: Set<string>,
    clientIp?: string,
    attemptedIds = new Set<string>(),
    cookies?: string,
  ): string | null {
    const now = Date.now();
    const candidates: UpstreamState[] = [];

    for (const [id, s] of this.states.entries()) {
      if (!healthyIds.has(id) || !s.healthy) continue;
      if (attemptedIds.has(id)) continue;

      // Handle Circuit Breaker recovery transitions
      if (s.state === "OPEN") {
        if (now - s.lastFailureTime > this.recoveryTimeMs) {
          logger.info("CircuitBreaker", `${id} entering HALF_OPEN probe phase`);
          s.state = "HALF_OPEN";
          s.slowStartEndTime = now + this.slowStartSeconds * 1000;
        } else {
          continue; // skip OPEN hosts
        }
      }

      // Respect Max Connections Constraint
      if (s.maxConnections !== undefined && s.activeConnections >= s.maxConnections) {
        continue;
      }

      candidates.push(s);
    }

    if (candidates.length === 0) return null;

    const halfOpenCandidates = candidates.filter(s => s.state === 'HALF_OPEN');
    const normalCandidates = candidates.filter(s => s.state !== 'HALF_OPEN');

    // 1. Google SRE Adaptive Throttling Check (K = 2)
    const K = 2;
    const sre_filtered = normalCandidates.filter((s) => {
      const dropProb = Math.max(0, (s.requests - K * s.accepts) / (s.requests + 1));
      if (dropProb > 0 && Math.random() < dropProb) {
        logger.warn("CircuitBreaker", `Google SRE Adaptive Throttling shed request to ${s.id}`, { dropProb });
        return false;
      }
      return true;
    });

    const pool = sre_filtered.length > 0 ? sre_filtered : normalCandidates;

    // HALF_OPEN probes bypass strategy selection entirely — always probe first available
    if (halfOpenCandidates.length > 0) {
      return halfOpenCandidates[0]!.id;
    }

    // 2. Select strategy
    let chosen: UpstreamState | null = null;

    // Sticky session check
    if (this.strategy === "sticky-sessions" && cookies) {
      const match = cookies.match(new RegExp(`(?:^|; )${this.stickyCookieName}=([^;]*)`));
      if (match && match[1]) {
        const stickyId = match[1];
        const state = pool.find((s) => s.id === stickyId);
        if (state) return state.id;
      }
    }

    switch (this.strategy) {
      case "round-robin": {
        const item = pool[this.roundRobinIndex % pool.length];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % pool.length;
        chosen = item ?? null;
        break;
      }

      case "weighted-round-robin": {
        let totalWeight = 0;
        let bestCandidate: UpstreamState | null = null;
        for (const s of pool) {
          let weight = s.weight;
          if (s.slowStartEndTime > now) {
            const factor = Math.max(0.1, 1.0 - (s.slowStartEndTime - now) / (this.slowStartSeconds * 1000));
            weight = Math.round(weight * factor);
          }
          s.currentWeight += weight;
          totalWeight += weight;
          if (!bestCandidate || s.currentWeight > bestCandidate.currentWeight) {
            bestCandidate = s;
          }
        }
        if (bestCandidate && totalWeight > 0) {
          bestCandidate.currentWeight -= totalWeight;
          chosen = bestCandidate;
        } else {
          chosen = pool[0] ?? null;
        }
        break;
      }

      case "adaptive-wrr": {
        // Adjust weight using latency + error rate
        let total = 0;
        const weights = pool.map((s) => {
          const errorRate = s.failures / (s.requests + 1);
          let weight = Math.max(1, Math.round(s.weight * (1 / (1 + s.responseTime / 100)) * (1 - errorRate)));
          if (s.slowStartEndTime > now) {
            const factor = Math.max(0.1, 1.0 - (s.slowStartEndTime - now) / (this.slowStartSeconds * 1000));
            weight = Math.max(1, Math.round(weight * factor));
          }
          total += weight;
          return weight;
        });

        let randomWeight = Math.floor(Math.random() * total);
        for (let i = 0; i < pool.length; i++) {
          randomWeight -= weights[i]!;
          if (randomWeight < 0) {
            chosen = pool[i] ?? null;
            break;
          }
        }
        if (!chosen) chosen = pool[0] ?? null;
        break;
      }

      case "least-connections": {
        chosen = pool.reduce((prev, curr) => (curr.activeConnections < prev.activeConnections ? curr : prev));
        break;
      }

      case "weighted-least-connections": {
        chosen = pool.reduce((prev, curr) => {
          const ratioCurr = curr.activeConnections / curr.weight;
          const ratioPrev = prev.activeConnections / prev.weight;
          return ratioCurr < ratioPrev ? curr : prev;
        });
        break;
      }

      case "least-response-time": {
        chosen = pool.reduce((prev, curr) => (curr.responseTime < prev.responseTime ? curr : prev));
        break;
      }

      case "random": {
        chosen = pool[Math.floor(Math.random() * pool.length)] ?? null;
        break;
      }

      case "power-of-two": {
        if (pool.length === 1) {
          chosen = pool[0] ?? null;
        } else {
          const i1 = Math.floor(Math.random() * pool.length);
          let i2 = Math.floor(Math.random() * pool.length);
          while (i2 === i1) i2 = Math.floor(Math.random() * pool.length);
          const a = pool[i1]!;
          const b = pool[i2]!;
          chosen = a.activeConnections <= b.activeConnections ? a : b;
        }
        break;
      }

      case "ip-hash": {
        if (clientIp) {
          const hash = this.fnv1a(clientIp);
          chosen = pool[hash % pool.length] ?? null;
        } else {
          chosen = pool[0] ?? null;
        }
        break;
      }

      case "consistent-hashing": {
        if (clientIp) {
          const hash = this.fnv1a(clientIp);
          const ring = this.hashRing.length > 0 ? this.hashRing : [];
          if (ring.length === 0) {
            chosen = pool[0] ?? null;
          } else {
            let idx = ring.findIndex((node) => node.hash >= hash);
            if (idx === -1) idx = 0;
            const targetId = ring[idx]!.id;
            chosen = pool.find((s) => s.id === targetId) ?? pool[0] ?? null;
          }
        } else {
          chosen = pool[0] ?? null;
        }
        break;
      }

      case "resource-based": {
        chosen = pool.reduce((prev, curr) => {
          const scoreCurr = this.getResourceScore(curr.id);
          const scorePrev = this.getResourceScore(prev.id);
          return scoreCurr < scorePrev ? curr : prev;
        });
        break;
      }

      default: {
        chosen = pool[0] ?? null;
        break;
      }
    }

    return chosen ? chosen.id : null;
  }

  public getStats() {
    const list: Record<string, any> = {};
    for (const [id, s] of this.states.entries()) {
      list[id] = {
        id: s.id,
        weight: s.weight,
        activeConnections: s.activeConnections,
        failures: s.failures,
        state: s.state,
        responseTime: s.responseTime,
        healthy: s.healthy,
      };
    }
    return {
      strategy: this.strategy,
      upstreams: list,
    };
  }
}
