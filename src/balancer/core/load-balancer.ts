import type { LoadBalancerOptions } from "../../types/balancer.types.js";
import { logger } from "../../observability/logger/logger.js";
import type { UpstreamState } from "../../types/upstream.types.js";
import { circuitBreakerManager } from "../../resilience/circuit-breaker/circuit-breaker.manager.js";
import { ClassicCircuitBreaker } from "../../resilience/circuit-breaker/classic.circuit-breaker.js";


export class LoadBalancer {
  private strategy: string;
  private virtualNodes: number;
  private ewmaAlpha: number;
  private stickyCookieName: string;
  private slowStartSeconds: number;
  private circuitBreakerConfig: any;

  private states = new Map<string, UpstreamState>();
  private roundRobinIndex = 0;
  private hashRing: Array<{ hash: number; id: string }> = [];

  constructor(options: LoadBalancerOptions) {
    this.strategy = options.strategy;
    this.virtualNodes = options.virtualNodes ?? 150;
    this.ewmaAlpha = options.ewmaAlpha ?? 0.1;
    this.stickyCookieName = options.stickyCookieName ?? "NINJA_ROUTE";
    this.slowStartSeconds = options.slowStartSeconds ?? 30;

    this.circuitBreakerConfig = options.circuitBreaker ?? {
      mode: "classic",
      failureThreshold: options.failureThreshold ?? 3,
      recoveryTimeMs: options.recoveryTimeMs ?? 15000,
      K: 2,
      windowMs: 10000,
    };

    for(const upstream of options.upstreams) {
      this.states.set(upstream.id, {
        id: upstream.id,
        weight: upstream.weight ?? 1,
        activeConnections: 0,
        failures: 0,
        state: "CLOSED",
        lastFailureTime: 0,
        responseTime: 10,
        healthy: true,
        requests: 0,
        accepts: 0,
        slowStartEndTime: 0,
        maxConnections: upstream.maxConnections,
        currentWeight: 0,
      } as UpstreamState);
      circuitBreakerManager.getOrCreate(
        upstream.id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig
      );
    }

    if(this.strategy === "consistent-hashing") {
      this.rebuildHashRing();
    }
  }

  public addUpstream(id: string, url: string, weight = 1, maxConnections?: number) {
    if(this.states.has(id)) return;
    this.states.set(id, {
      id,
      url,
      activeConnections: 0,
      failures: 0,
      lastFailureTime: 0,
      state: "CLOSED",
      healthy: true,
      weight,
      responseTime: 10,
      totalBytes: 0,
      requests: 0,
      accepts: 0,
      slowStartEndTime: 0,
      maxConnections,
      currentWeight: 0,
    } as any);

    circuitBreakerManager.getOrCreate(
      id,
      this.circuitBreakerConfig.mode,
      this.circuitBreakerConfig
    );

    if(this.strategy === "consistent-hashing") {
      this.rebuildHashRing();
    }
  }

  public removeUpstream(id: string) {
    if(this.states.delete(id)) {
      if(this.strategy === "consistent-hashing") {
        this.rebuildHashRing();
      }
    }
  }

  public setHealthy(id: string, healthy: boolean) {
    const s = this.states.get(id);
    if(s) {
      if(s.healthy !== healthy) {
        logger.info("LoadBalancer", `Upstream health changed: ${id} -> ${healthy ? "HEALTHY" : "UNHEALTHY"}`);
        s.healthy = healthy;
        if(healthy) {
          const cb = circuitBreakerManager.getOrCreate(
            id,
            this.circuitBreakerConfig.mode,
            this.circuitBreakerConfig
          );
          if(cb instanceof ClassicCircuitBreaker && cb.getState() === "OPEN") {
            cb.recordSuccess(0); 
          }
          s.slowStartEndTime = Date.now() + this.slowStartSeconds * 1000;
        }
      }
    }
  }

  public incrementConnection(id: string) {
    const s = this.states.get(id);
    if(s) {
      s.activeConnections++;
    }
  }

  public releaseConnection(id: string) {
    const s = this.states.get(id);
    if(s && s.activeConnections > 0) {
      s.activeConnections--;
    }
  }

  private rebuildHashRing() {
    this.hashRing = [];
    for(const [id, s] of this.states.entries()) {
      for(let i = 0; i < this.virtualNodes; i++) {
        const hash = this.fnv1a(`${id}#vnode${i}`);
        this.hashRing.push({ hash, id });
      }
    }
    this.hashRing.sort((a, b) => a.hash - b.hash);
  }

  private fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for(let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }

  private computeResourceScore(id: string): number {
    const s = this.states.get(id);
    if(!s) return 0;
    return s.activeConnections / Math.max(1, s.weight);
  }

  public recordSuccess(id: string, latencyMs = 0) {
    const s = this.states.get(id);
    if(!s) return;

    s.responseTime = this.ewmaAlpha * latencyMs + (1 - this.ewmaAlpha) * s.responseTime;
    const cb = circuitBreakerManager.getOrCreate(
      id,
      this.circuitBreakerConfig.mode,
      this.circuitBreakerConfig
    );
    const prevState = cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";
    cb.recordSuccess(latencyMs);
    const postState = cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";

    if(cb instanceof ClassicCircuitBreaker && (prevState === "OPEN" || prevState === "HALF_OPEN") && postState === "CLOSED") {
      logger.info("CircuitBreaker", `${id} restored to CLOSED state`);
      s.slowStartEndTime = 0;
      let totalWeight = 0;
      for(const [_, state] of this.states) {
        const peerCb = circuitBreakerManager.getOrCreate(
          state.id,
          this.circuitBreakerConfig.mode,
          this.circuitBreakerConfig
        );
        const peerOpen = peerCb instanceof ClassicCircuitBreaker && peerCb.getState() === "OPEN";
        if(state.healthy && !peerOpen) {
          totalWeight += state.weight;
        }
      }
      s.currentWeight -= totalWeight;
    }
  }

  public recordFailure(id: string) {
    const s = this.states.get(id);
    if(!s) return;

    const cb = circuitBreakerManager.getOrCreate(
      id,
      this.circuitBreakerConfig.mode,
      this.circuitBreakerConfig
    );
    const prevState = cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";
    cb.recordFailure();
    const postState = cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";

    if(cb instanceof ClassicCircuitBreaker && prevState !== "OPEN" && postState === "OPEN") {
      logger.warn("CircuitBreaker", `${id} tripped to OPEN state`);
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

    for(const [id, s] of this.states.entries()) {
      if(!healthyIds.has(id) || !s.healthy) continue;
      if(attemptedIds.has(id)) continue;

      const cb = circuitBreakerManager.getOrCreate(
        id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig
      );
      if(!cb.isAllowed()) {
        continue; 
      }
      if(s.maxConnections !== undefined && s.activeConnections >= s.maxConnections) {
        continue;
      }

      candidates.push(s);
    }

    if(candidates.length === 0) return null;
    const halfOpenCandidates = candidates.filter(s => {
      const cb = circuitBreakerManager.getOrCreate(
        s.id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig
      );
      return cb instanceof ClassicCircuitBreaker && cb.getState() === "HALF_OPEN";
    });

    if(halfOpenCandidates.length > 0) {
      return halfOpenCandidates[0]!.id;
    }
    let chosen: UpstreamState | null = null;
    if(this.strategy === "sticky-sessions" && cookies) {
      const match = cookies.match(new RegExp(`(?:^|; )${this.stickyCookieName}=([^;]*)`));
      if(match && match[1]) {
        const stickyId = match[1];
        const state = candidates.find((s) => s.id === stickyId);
        if (state) return state.id;
      }
    }
    switch (this.strategy) {
      case "round-robin": {
        const idx = this.roundRobinIndex % candidates.length;
        this.roundRobinIndex++;
        chosen = candidates[idx]!;
        break;
      }
      case "weighted-round-robin": {
        let best: UpstreamState | null = null;
        let totalWeight = 0;
        for(const s of candidates) {
          let effectiveWeight = s.weight;
          if(s.slowStartEndTime > 0 && now < s.slowStartEndTime) {
            const timeLeft = s.slowStartEndTime - now;
            const progress = 1 - timeLeft / (this.slowStartSeconds * 1000);
            effectiveWeight = Math.max(1, Math.floor(s.weight * progress));
          }
          s.currentWeight += effectiveWeight;
          totalWeight += effectiveWeight;
          if(!best || s.currentWeight > best.currentWeight) {
            best = s;
          }
        }
        if(best) {
          best.currentWeight -= totalWeight;
          chosen = best;
        }
        break;
      }
      case "least-connections": {
        chosen = candidates.reduce((prev, curr) =>
          curr.activeConnections < prev.activeConnections ? curr : prev
        );
        break;
      }
      case "weighted-least-connections": {
        chosen = candidates.reduce((prev, curr) => {
          const prevScore = prev.activeConnections / (prev.weight || 1);
          const currScore = curr.activeConnections / (curr.weight || 1);
          return currScore < prevScore ? curr : prev;
        });
        break;
      }
      case "least-response-time": {
        chosen = candidates.reduce((prev, curr) =>
          curr.responseTime < prev.responseTime ? curr : prev
        );
        break;
      }
      case "power-of-two": {
        if(candidates.length === 1) {
          chosen = candidates[0]!;
        } else {
          const idx1 = Math.floor(Math.random() * candidates.length);
          let idx2 = Math.floor(Math.random() * candidates.length);
          while (idx1 === idx2) {
            idx2 = Math.floor(Math.random() * candidates.length);
          }
          const choice1 = candidates[idx1]!;
          const choice2 = candidates[idx2]!;
          chosen = choice1.activeConnections <= choice2.activeConnections ? choice1 : choice2;
        }
        break;
      }
      case "consistent-hashing": {
        if(clientIp) {
          const hash = this.fnv1a(clientIp);
          const ringMatch = this.hashRing.find((node) => node.hash >= hash) ?? this.hashRing[0];
          if (ringMatch) {
            chosen = candidates.find((s) => s.id === ringMatch.id) ?? candidates[0]!;
          }
        }
        break;
      }
      case "ip-hash": {
        if(clientIp) {
          const hash = this.fnv1a(clientIp);
          chosen = candidates[hash % candidates.length]!;
        }
        break;
      }
      case "resource-based": {
        chosen = candidates.reduce((prev, curr) => {
          const prevScore = this.computeResourceScore(prev.id);
          const currScore = this.computeResourceScore(curr.id);
          return currScore < prevScore ? curr : prev;
        });
        break;
      }
      case "random":
      default: {
        chosen = candidates[Math.floor(Math.random() * candidates.length)]!;
        break;
      }
    }
    return chosen ? chosen.id : null;
  }
  public getStats(): any[] {
    const list: any[] = [];
    for(const [id, s] of this.states.entries()) {
      const cb = circuitBreakerManager.getOrCreate(
        id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig
      );
      list.push({
        id,
        activeConnections: s.activeConnections,
        failures: cb instanceof ClassicCircuitBreaker ? cb.getFailures() : 0,
        state: cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED",
        responseTime: s.responseTime,
        healthy: s.healthy,
      });
    }
    return list;
  }
}
