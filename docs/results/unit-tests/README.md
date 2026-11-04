# Unit Test Results

## What Is Tested Here
In-memory module-level tests. No running servers, no open ports.
Each test imports from `dist/` and exercises a single class or algorithm.

## Test Files
| File | Subsystem | What It Covers |
|------|-----------|----------------|
| tests/unit/balancer/balancerAllStrategies.test.ts | Load Balancer | All 12 strategy pick() behaviors |
| tests/unit/balancer/loadBalancer.test.ts | Load Balancer | CoreLoadBalancer.pickFiltered(), connection tracking |
| tests/unit/balancer/loadBalancerAdvanced.test.ts | Load Balancer | Weighted round-robin math, P2C, consistent hashing |
| tests/unit/cache/cache.test.ts | Cache | InMemoryLRU, HybridCache L1/L2 |
| tests/unit/cache/cacheAllFeatures.test.ts | Cache | KeyBuilder, parseCacheControl, SWR, StaleIfError, Tag/Pattern/Debezium invalidation |
| tests/unit/discovery/discovery.test.ts | Discovery | ServiceRegistry lifecycle, ActiveProbe HTTP check |
| tests/unit/discovery/discoveryAllFeatures.test.ts | Discovery | PassiveProbe events, disk snapshot atomicity |
| tests/unit/observability/observabilityAllFeatures.test.ts | Observability | Histogram buckets, MetricsRegistry, TenantLogStreamer |
| tests/unit/ratelimit/rateLimitAllAlgorithms.test.ts | Rate Limit | All 5 algorithms, SoftLimitPolicy |
| tests/unit/ratelimit/rateLimiter.test.ts | Rate Limit | Facade integration, MemoryStore |
| tests/unit/resilience/circuitBreaker.test.ts | Resilience | ClassicCB state machine, AdaptiveCB stats |
| tests/unit/resilience/resilience.test.ts | Resilience | Bulkhead slots, retry handler |
| tests/unit/resilience/resilienceAllFeatures.test.ts | Resilience | All 4 jitter backoffs, RetryBudget, CBManager |

## How to Run
```bash
npm run test:audit      
npm test  
```

## Results
_Results are recorded here after each run. See this folder for future run snapshots._
