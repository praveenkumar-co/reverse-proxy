# Ninja Reverse Proxy — Documentation Index

A production-grade Layer 7 reverse proxy and load balancer written in TypeScript.

---

## Core Subsystems

| # | File | What It Covers |
|---|------|----------------|
| 01 | [01-websocket.md](./01-websocket.md) | WebSocket proxying — HTTP Upgrade handshake, TLSSocket pipe tunnel, sticky session for WS |
| 02 | [02-tls-https.md](./02-tls-https.md) | TLS/HTTPS — cert loading, handshake, HTTP→HTTPS redirect (8080→8443) |
| 03 | [03-load-balancing.md](./03-load-balancing.md) | Load balancing — all 12 strategies, WRR math, consistent hashing ring, P2C |
| 04 | [04-health-checks.md](./04-health-checks.md) | Health checks — active probe (HTTP ping), passive probe (error event bus), state transitions |
| 05 | [05-rate-limiting.md](./05-rate-limiting.md) | Rate limiting — 5 algorithms, SoftLimitPolicy burst, MemoryStore/RedisStore/HybridStore |
| 06 | [06-circuit-breaker.md](./06-circuit-breaker.md) | Circuit breaker — ClassicCB (3-state machine), AdaptiveCB (Google SRE drop probability) |
| 07 | [07-caching.md](./07-caching.md) | Caching — InMemoryLRU, HybridCache L1+L2, KeyBuilder, StaleIfError, StaleWhileRevalidate |
| 08 | [08-master-worker-architecture.md](./08-master-worker-architecture.md) | Cluster — Master/Worker via Node.js cluster, IPC dispatch, worker auto-restart, SIGTERM guard |
| 09 | [09-service-registry.md](./09-service-registry.md) | Service registry — register/heartbeat/deregister, atomic disk snapshot (.tmp→rename), callbacks |
| 10 | [10-middleware-pipeline.md](./10-middleware-pipeline.md) | Middleware pipeline — onion model, RequestContext (clientIp, startTime, metadata), next() chaining |
| 11 | [11-observability.md](./11-observability.md) | Observability — MetricsRegistry (Prometheus), Histogram buckets, structured logger, multi-worker merge |
| 12 | [12-https-request-flow.md](./12-https-request-flow.md) | Full HTTPS request flow — TLS termination → master → IPC → worker → upstream → response |
| 13 | [13-config-zod-validation.md](./13-config-zod-validation.md) | Config — Zod schema validation, proxy.yaml parsing, hot-reload via SIGHUP |

## Deep Dives

| # | File | What It Covers |
|---|------|----------------|
| 14 | [14-retry-bulkhead.md](./14-retry-bulkhead.md) | Retry — RetryHandler, RetryBudget (15% ratio), 4 jitter backoff algorithms; Bulkhead concurrency slots |
| 15 | [15-connection-pool.md](./15-connection-pool.md) | Connection pool — httpAgent/httpsAgent singletons, keepAlive=true, maxSockets=256 |
| 16 | [16-multi-tier-caching.md](./16-multi-tier-caching.md) | Two-tier cache — InMemoryLRU L1 fast-path, HybridCache L2 write-through, TTL eviction |
| 17 | [17-cdc-cache-invalidation.md](./17-cdc-cache-invalidation.md) | CDC invalidation — Debezium event stream → DebeziumInvalidator → table→path mapping → cache purge |
| 18 | [18-tracing.md](./18-tracing.md) | Distributed tracing — Tracer span lifecycle, traceId/spanId, X-Trace-Id header propagation |
| 19 | [19-readiness-liveness.md](./19-readiness-liveness.md) | Readiness probe — multi-check health gate, ReadinessProbe.isReady() returns {ready, checks} |
| 20 | [20-tenant-log-streamer.md](./20-tenant-log-streamer.md) | Tenant log streamer — per-tenant webhook delivery, queueLog/flush, destination routing |
| 21 | [21-deployment.md](./21-deployment.md) | Deployment — local run, TLS cert generation, monitoring stack (Prometheus + Grafana via Docker) |
| 22 | [22-testing-strategy.md](./22-testing-strategy.md) | Testing — unit / integration / smoke / load / chaos pyramid, what each level verifies |

---

## System Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              Client (Browser / App)          │
                    └────────────────────┬────────────────────────┘
                                         │  HTTPS (TLS 1.3)
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │            MASTER PROCESS (port 8443)       │
                    │                                              │
                    │  ┌──────────┐   ┌──────────────────────┐   │
                    │  │ Rate     │   │  RouteMatcher        │   │
                    │  │ Limiter  │──▶│  (first-match rules) │   │
                    │  └──────────┘   └──────────┬───────────┘   │
                    │                             │               │
                    │                 ┌───────────▼───────────┐  │
                    │                 │  LoadBalancer         │  │
                    │                 │  .pickFiltered()      │  │
                    │                 │  (12 strategies)      │  │
                    │                 └───────────┬───────────┘  │
                    └─────────────────────────────┼──────────────┘
                                                  │ IPC send(msg)
                    ┌─────────────────────────────▼──────────────┐
                    │            WORKER PROCESS(ES)              │
                    │                                             │
                    │  Middleware pipeline (onion model):         │
                    │  Auth → CircuitBreaker → Bulkhead →        │
                    │  Cache(L1+L2) → Retry → ProxyForward       │
                    └─────────────────────────────┬──────────────┘
                                                  │ HTTP/1.1 keep-alive
                    ┌─────────────────────────────▼──────────────┐
                    │            UPSTREAM BACKENDS               │
                    │  chess-backend-1 (127.0.0.1:3009, w=1)    │
                    │  chess-backend-2 (127.0.0.1:3010, w=3)    │
                    └────────────────────────────────────────────┘
```

---

## Key Source Files

| File | Role |
|------|------|
| `src/core/cluster/master.ts` | Master process: server, load balancing, IPC dispatch |
| `src/core/pipeline/context.ts` | RequestContext — clientIp, startTime, metadata |
| `src/core/router/route.matcher.ts` | RouteMatcher — first-match with optional method guards |
| `src/balancer/core/load-balancer.ts` | LoadBalancer.pickFiltered(candidateSet, ip, excluded, cookie) |
| `src/resilience/circuit-breaker/classic.circuit-breaker.ts` | CLOSED→OPEN→HALF_OPEN state machine |
| `src/resilience/circuit-breaker/adaptive.circuit-breaker.ts` | Google SRE drop probability formula |
| `src/cache/stores/hybrid.cache.ts` | HybridCache — L1 InMemoryLRU + L2 Redis write-through |
| `src/observability/metrics/prometheus.exporter.ts` | MetricsRegistry — full OpenMetrics exposition |
| `src/discovery/registry/dynamic.registry.ts` | ServiceRegistry — heartbeat + atomic disk snapshot |
| `src/core/proxy/connection.pool.ts` | httpAgent + httpsAgent singletons |

## Ports

| Port | Purpose |
|------|---------|
| `8080` | HTTP — always redirects to 8443 |
| `8443` | HTTPS — main proxy entry point |
| `9091` | Metrics — Prometheus scrape target (on proxy) |
| `9090` | Prometheus UI (Docker monitoring stack) |
| `3000` | Grafana dashboards (Docker monitoring stack) |
| `3009` | Chess backend node 1 (weight=1) |
| `3010` | Chess backend node 2 (weight=3) |
