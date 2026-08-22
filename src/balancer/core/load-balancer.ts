import type { LoadBalancerOptions } from "../../types/balancer.types.js";
import { logger } from "../../observability/logger/logger.js";
import type { UpstreamState } from "../../types/upstream.types.js";
import { circuitBreakerManager } from "../../resilience/circuit-breaker/circuit-breaker.manager.js";
import { ClassicCircuitBreaker } from "../../resilience/circuit-breaker/classic.circuit-breaker.js";
import { AdaptiveCircuitBreaker } from "../../resilience/circuit-breaker/adaptive.circuit-breaker.js";
import type { IStrategy } from "../contracts/strategy.interface.js";

export class LoadBalancer {
  private strategy: IStrategy;
  private ewmaAlpha: number;
  private slowStartSeconds: number;
  private circuitBreakerConfig: any;
  private states = new Map<string, UpstreamState>();

  constructor(options: LoadBalancerOptions, strategy: IStrategy) {
    this.strategy = strategy;
    this.ewmaAlpha = options.ewmaAlpha ?? 0.1;
    this.slowStartSeconds = options.slowStartSeconds ?? 30;

    this.circuitBreakerConfig = options.circuitBreaker ?? {
      mode: "classic",
      failureThreshold: options.failureThreshold ?? 3,
      recoveryTimeMs: options.recoveryTimeMs ?? 15000,
      K: 2,
      windowMs: 10000,
    };

    for (const upstream of options.upstreams) {
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
        this.circuitBreakerConfig,
      );
    }

    this.notifyStrategy();
  }

  public addUpstream(
    id: string,
    url: string,
    weight = 1,
    maxConnections?: number,
  ) {
    if (this.states.has(id)) return;

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
      this.circuitBreakerConfig,
    );

    this.notifyStrategy();
  }

  public removeUpstream(id: string) {
    if (this.states.delete(id)) {
      this.notifyStrategy();
    }
  }

  public setHealthy(id: string, healthy: boolean) {
    const s = this.states.get(id);
    if (!s) return;

    if (s.healthy !== healthy) {
      logger.info(
        "LoadBalancer",
        `Upstream health changed: ${id} -> ${healthy ? "HEALTHY" : "UNHEALTHY"}`,
      );
      s.healthy = healthy;

      if (healthy) {
        const cb = circuitBreakerManager.getOrCreate(
          id,
          this.circuitBreakerConfig.mode,
          this.circuitBreakerConfig,
        );
        if (
          cb instanceof ClassicCircuitBreaker &&
          cb.getState() === "OPEN"
        ) {
          cb.recordSuccess(0);
        }
        s.slowStartEndTime = Date.now() + this.slowStartSeconds * 1000;
      }
    }
  }

  public incrementConnection(id: string) {
    const s = this.states.get(id);
    if (s) s.activeConnections++;
  }

  public releaseConnection(id: string) {
    const s = this.states.get(id);
    if (s && s.activeConnections > 0) s.activeConnections--;
  }

  public recordSuccess(id: string, latencyMs = 0) {
    const s = this.states.get(id);
    if (!s) return;

    s.responseTime =
      this.ewmaAlpha * latencyMs + (1 - this.ewmaAlpha) * s.responseTime;

    const cb = circuitBreakerManager.getOrCreate(
      id,
      this.circuitBreakerConfig.mode,
      this.circuitBreakerConfig,
    );
    const prevState =
      cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";
    cb.recordSuccess(latencyMs);
    const postState =
      cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";

    if (
      cb instanceof ClassicCircuitBreaker &&
      (prevState === "OPEN" || prevState === "HALF_OPEN") &&
      postState === "CLOSED"
    ) {
      logger.info("CircuitBreaker", `${id} restored to CLOSED state`);
      s.slowStartEndTime = 0;

      let totalWeight = 0;
      for (const [, state] of this.states) {
        const peerCb = circuitBreakerManager.getOrCreate(
          state.id,
          this.circuitBreakerConfig.mode,
          this.circuitBreakerConfig,
        );
        const peerOpen =
          peerCb instanceof ClassicCircuitBreaker &&
          peerCb.getState() === "OPEN";
        if (state.healthy && !peerOpen) {
          totalWeight += state.weight;
        }
      }
      s.currentWeight -= totalWeight;
    }
  }

  public recordFailure(id: string) {
    const s = this.states.get(id);
    if (!s) return;

    const cb = circuitBreakerManager.getOrCreate(
      id,
      this.circuitBreakerConfig.mode,
      this.circuitBreakerConfig,
    );
    const prevState =
      cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";
    cb.recordFailure();
    const postState =
      cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED";

    if (
      cb instanceof ClassicCircuitBreaker &&
      prevState !== "OPEN" &&
      postState === "OPEN"
    ) {
      logger.warn("CircuitBreaker", `${id} tripped to OPEN state`);
    }
  }
  public pickFiltered(
    healthyIds: Set<string>,
    clientIp?: string,
    attemptedIds = new Set<string>(),
    cookies?: string,
  ): string | null {
    const candidates: UpstreamState[] = [];

    for (const [id, s] of this.states.entries()) {
      if (!healthyIds.has(id) || !s.healthy) continue;
      if (attemptedIds.has(id)) continue;

      const cb = circuitBreakerManager.getOrCreate(
        id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig,
      );
      if (!cb.isAllowed()) continue;

      if (
        s.maxConnections !== undefined &&
        s.activeConnections >= s.maxConnections
      ) {
        continue;
      }

      candidates.push(s);
    }

    if (candidates.length === 0) return null;
    const halfOpenCandidates = candidates.filter((s) => {
      const cb = circuitBreakerManager.getOrCreate(
        s.id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig,
      );
      return (
        cb instanceof ClassicCircuitBreaker && cb.getState() === "HALF_OPEN"
      );
    });

    if (halfOpenCandidates.length > 0) {
      return halfOpenCandidates[0]!.id;
    }
    const chosen = this.strategy.pick(candidates, clientIp, cookies);
    return chosen ? chosen.id : null;
  }

  public getStats(): any[] {
    const list: any[] = [];
    for (const [id, s] of this.states.entries()) {
      const cb = circuitBreakerManager.getOrCreate(
        id,
        this.circuitBreakerConfig.mode,
        this.circuitBreakerConfig,
      );
      list.push({
        id,
        activeConnections: s.activeConnections,
        failures:
          cb instanceof ClassicCircuitBreaker ? cb.getFailures() : 0,
        state:
          cb instanceof ClassicCircuitBreaker ? cb.getState() : "CLOSED",
        responseTime: s.responseTime,
        healthy: s.healthy,
        ...(cb instanceof AdaptiveCircuitBreaker ? { adaptiveStats: cb.getStats() } : {}),
      });
    }
    return list;
  }

  private notifyStrategy() {
    if (this.strategy.onUpstreamsChanged) {
      this.strategy.onUpstreamsChanged([...this.states.values()]);
    }
  }
}
