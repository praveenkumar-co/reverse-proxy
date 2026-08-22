## Goal

Review and configure the `src` folder so the load-balancer, cache, rate-limiter, invalidator, store, contracts/interfaces, discovery, health checks, observability, and resilience patterns (retry/backoff, circuit-breaker, bulkhead) are coherent, well-scoped, and easy to maintain.

## Summary of current state

Most pieces already exist in `src`:

- Load balancer strategies: `src/balancer/**`
- Discovery/registry: `src/discovery/**`
- Cache manager, invalidators and stores: `src/cache/**`
- Rate-limiter algorithms + storage: `src/ratelimit/**`
- Circuit breaker implementations + states: `src/resilience/circuit-breaker/**`
- Retry/backoff handlers: `src/resilience/retry/**`
- Observability: `src/observability/**`
- Core proxy and cluster: `src/core/**`
    
## High-level recommended changes

1. Consolidate contracts/interfaces
   - Create a dedicated `src/contracts` (or `src/interfaces`) directory and export central types used across balancer, cache, rate-limit, resilience, and discovery.
   - Ensure each public function accepts typed contracts instead of ad-hoc objects.

2. Improve cache layering (L1/L2 hybrid)
   - Ensure `src/cache/stores/hybrid.cache.ts` exposes clear L1 (in-memory LRU) & L2 (Redis) semantics and TTL propagation.
   - Add cache-control header parsing in `cache/policies/cache-control.parser.ts` to decide TTL/stale behaviors.
   - Validate invalidator hooks (Debezium, tag, pattern) call cache-manager correctly.

3. Standardize resilience contracts
   - Define `RetryPolicy`, `BackoffStrategy`, `CircuitBreakerOptions`, and `BulkheadOptions` in `src/resilience/contracts` and wire existing implementations to them.
   - Make circuit-breaker manager accept typed dependencies (metrics, clock) for testability.

4. Rate limiter: unify interfaces and storage
   - Ensure `ratelimit/contracts/storage.interface.ts` and `limiter.interface.ts` are implemented by `memory`, `redis`, and `hybrid` stores.
   - Offer a pluggable policy registry to load `token-bucket`, `sliding-window`, etc.

5. Observability and metrics
   - Expose metric hooks in core proxy and balancer to emit counters/histograms (`request_total`, `request_latency`, `upstream_errors`, `cache_hit`, `cache_miss`).
   - Add tracing spans in `core/pipeline` and proxy handlers.

6. Security and middleware
   - Harden middleware to defend against "middleman" attacks: strict Host header checks, TLS termination verification, header sanitization, and origin validation. Put these in `src/middleware/security.*`.

7. Routes, discovery and health
   - Ensure discovery and health probes are used by balancer strategies for target selection and by circuit-breaker and retry logic.
   - Expose `/healthz` and `/readyz` using `observability/health`.

8. Connector and Debezium invalidation
   - Confirm `cache/invalidation/debezium.invalidator.ts` has robust retry/backoff and idempotency when invalidation events arrive out-of-order.

9. Bulkhead and concurrency
   - Add a bulkhead wrapper (semaphores) for upstream calls: `resilience/bulkhead/bulkhead.ts` is present, ensure usage in proxy client.

10. Documentation & tests

- Add unit tests for contracts and critical parts (cache hybrid semantics, circuit breaker transitions, rate-limiter policies).

## Concrete file-level suggestions (quick mapping)

- Contracts / Types
  - src/contracts/index.ts (new) — exports shared interfaces: `Service`, `TargetNode`, `HealthStatus`, `RetryPolicy`, `CircuitBreakerOptions`, `CacheOptions`, `LimiterOptions`.

- Cache
  - src/cache/stores/hybrid.cache.ts — ensure TTL propagation and L1 fallback logic.
  - src/cache/cache-manager.ts — ensure invalidator hook registration and metrics emission.
  - src/cache/policies/cache-control.parser.ts — ensure header parsing for TTL/stale-if-error/stale-while-revalidate.

- Resilience
  - src/resilience/contracts/retry.interface.ts (already exists) — align to `RetryPolicy` contract.
  - src/resilience/retry/retry-handler.ts — ensure budget and jittered backoff are pluggable.
  - src/resilience/circuit-breaker/\* — unify in manager to use shared options.
  - src/resilience/bulkhead/bulkhead.ts — ensure integrated in `core/proxy/upstream.client.ts` call path.

- Rate limit
  - src/ratelimit/contracts/storage.interface.ts — ensure hybrid store implements it.
  - src/ratelimit/index.ts — export policy registry and default policies.

- Core proxy & balancer
  - src/core/proxy/upstream.client.ts — instrument with metrics, retries, bulkhead and circuit-breaker wrappers.
  - src/balancer/core/load-balancer.ts — ensure it consults discovery health and circuits before choosing node.

- Observability
  - src/observability/metrics/prometheus.exporter.ts — ensure all metric names follow a convention and are invoked.
  - src/observability/tracing/tracer.ts — add span creation points in pipeline and proxy.

- Middleware
  - src/middleware/security.ts (new) — Host validation, header sanitization, request size limits (body-limit exists), and upstream header filtering.

## Prioritization

1. Contracts/types consolidation
2. Upstream call path instrumentation (metrics, retry, circuit-breaker, bulkhead)
3. Cache L1/L2 correctness + invalidators
4. Rate-limiter pluggable storage
5. Security middleware and header handling
6. Tests and docs

## Next actions I can take now

- Create `src/ARCHITECTURE_CHANGES.md` (done) and `src/contracts/index.ts` plus a small set of typed stubs.
- Scaffold `src/middleware/security.ts`, `src/observability/hooks.ts`, `src/resilience/bulkhead/index.ts` and a `src/contracts` barrel.
- Open a follow-up PR with focused changes for review.

Would you like me to scaffold the contracts and the minimal middleware/observability/resilience stubs now (I will only change files under `src`)? If yes, I will apply the scaffolding and update the TODO list accordingly.
