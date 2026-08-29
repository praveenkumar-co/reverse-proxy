import { LoadBalancer } from "../core/load-balancer.js";
import type { LoadBalancerOptions } from "../../types/balancer.types.js";
import { strategyRegistry } from "../core/strategy-registry.js";

import { RoundRobinStrategy } from "../strategies/round-robin.strategy.js";
import { WeightedRoundRobinStrategy } from "../strategies/weighted-round-robin.strategy.js";
import { LeastConnectionsStrategy } from "../strategies/least-connections.strategy.js";
import { WeightedLeastConnectionsStrategy } from "../strategies/weighted-least-connections.strategy.js";
import { LeastResponseTimeStrategy } from "../strategies/least-response-time.strategy.js";
import { PowerOfTwoStrategy } from "../strategies/power-of-two.strategy.js";
import { ConsistentHashingStrategy } from "../strategies/consistent-hashing.strategy.js";
import { IpHashStrategy } from "../strategies/ip-hash.strategy.js";
import { StickySessionsStrategy } from "../strategies/sticky-sessions.strategy.js";
import { ResourceBasedStrategy } from "../strategies/resource-based.strategy.js";
import { RandomStrategy } from "../strategies/random.strategy.js";
import { AdaptiveWrrStrategy } from "../strategies/adaptive-wrr.strategy.js";

export function createLoadBalancer(options: LoadBalancerOptions): LoadBalancer {
  const virtualNodes = options.virtualNodes ?? 150;
  const stickyCookieName = options.stickyCookieName ?? "NINJA_ROUTE";
  const slowStartSeconds = options.slowStartSeconds ?? 30;
  strategyRegistry.register("round-robin", new RoundRobinStrategy());
  strategyRegistry.register(
    "weighted-round-robin",
    new WeightedRoundRobinStrategy(slowStartSeconds),
  );
  strategyRegistry.register("least-connections", new LeastConnectionsStrategy());
  strategyRegistry.register(
    "weighted-least-connections",
    new WeightedLeastConnectionsStrategy(),
  );
  strategyRegistry.register(
    "least-response-time",
    new LeastResponseTimeStrategy(),
  );
  strategyRegistry.register("power-of-two", new PowerOfTwoStrategy());
  strategyRegistry.register(
    "consistent-hashing",
    new ConsistentHashingStrategy(virtualNodes),
  );
  strategyRegistry.register("ip-hash", new IpHashStrategy());
  strategyRegistry.register(
    "sticky-sessions",
    new StickySessionsStrategy(stickyCookieName),
  );
  strategyRegistry.register("resource-based", new ResourceBasedStrategy());
  strategyRegistry.register("random", new RandomStrategy());
  strategyRegistry.register("adaptive-wrr", new AdaptiveWrrStrategy(slowStartSeconds));

  const strategy =
    strategyRegistry.get(options.strategy) ??
    strategyRegistry.get("random")!;
  return new LoadBalancer(options, strategy);
}
