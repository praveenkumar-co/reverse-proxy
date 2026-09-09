# 🛡️ Ninja Reverse Proxy

A production-grade, backend-agnostic **Layer 7 Reverse Proxy & Load Balancer** built from scratch in TypeScript and Node.js.

Designed in the same engineering philosophy as **NGINX, Envoy, and HAProxy** — configure it once, point it at any backend, and it handles enterprise-grade traffic distribution, load balancing, rate limiting, multi-tier caching, resilience patterns, and health monitoring automatically.

---

## 🏛️ Master-Worker Architecture Overview

Ninja Reverse Proxy utilizes a highly performant **Master-Worker Cluster Architecture** that runs on all available CPU cores using Node.js Inter-Process Communication (IPC).

```
                     +----------------------------+
                     |        Client (WS/HTTPS)   |
                     +--------------+-------------+
                                    |
                                    ▼
                     +----------------------------+
                     |  Master Node (IPC Watchdog)|
                     +-------+------------+-------+
                             |            |
                    (IPC Chans)          (IPC Chans)
                             |            |
            +----------------v---+    +---v----------------+
            | Worker 1           |    | Worker 2           |
            | - HTTP/WS Pipeline |    | - HTTP/WS Pipeline |
            | - L1 In-Memory LRU |    | - L1 In-Memory LRU |
            +-------+------------+    +---+----------------+
                    |                     |
             (TCP/WSS Proxy)       (TCP/WSS Proxy)
                    |                     |
      +-------------v---------------------v-------------+
      |  Shared Distributed Tier:                       |
      |  - L2 Response Cache (Redis)                    |
      |  - Distributed Rate Limiter State (Redis Lua)   |
      |  - Telemetry & Dynamic Service Registry         |
      |  - Debezium CDC Invalidation Stream             |
      +------+------------------------------------+-----+
             |                                    |
             ▼                                    ▼
      +--------------+                     +--------------+
      | Upstream A   |                     | Upstream B   |
      +--------------+                     +--------------+
```

---

## 📐 Enterprise Design Patterns Implemented

1. **Strategy Pattern (`ILoadBalancerStrategy`, `IRateLimiterAlgorithm`)**: Decouples algorithm selection from proxy execution. All 12 load balancing and 5 rate limiting algorithms implement common interfaces and are swapped at runtime.
2. **Factory Pattern (`BalancerFactory`)**: Centralized instantiator that parses Zod schemas and generates configured load balancer strategies.
3. **Dependency Inversion Principle (SOLID)**: Core proxy components depend strictly on abstractions (`ICache`, `IInvalidator`, `IServiceRegistry`), enabling seamless swapping between Memory, Redis, and Hybrid stores.
4. **Koa/Express Onion Middleware Model**: Declarative pipeline (`RequestContext`, `MiddlewarePipeline`) executing CORS, Authentication, Tracing, Rate Limiting, Cache, and Circuit Breakers in non-blocking order.
5. **Zero-Copy TCP Socket Tunneling**: Direct bidirectional piping (`clientSocket.pipe(targetSocket)`) for WebSocket and HTTPS connections.

---

## 📂 Complete Repository Directory Structure

The following tree maps every single directory, file, and subsystem in the repository with its functional responsibility:

```text
reverse-proxy/
├── README.md                                  # Project overview, architecture & operational guide
├── package.json                               # Dependencies, engine versions & test scripts
├── pnpm-lock.yaml                             # Deterministic dependency lockfile
├── tsconfig.json                              # TypeScript base compiler configuration
├── tsconfig.build.json                        # Production build TS configuration (outputs to dist/)
├── tsconfig.test.json                         # Test runner TS configuration (outputs to dist-test/)
├── jest.config.ts                             # Jest testing framework configuration
├── sonar-project.properties                   # SonarQube code quality & security gate settings
├── config.yaml                                # Active reverse proxy configuration file
├── config.example.yaml                        # Annotated reference configuration template
├── .gitignore                                 # Ignored artifacts, logs & local certificates
│
├── deploy/                                    # Deployment & infrastructure manifests
│   └── monitoring/
│       ├── docker-compose.monitoring.yml      # Compose stack for Prometheus (:9090) & Grafana (:3000)
│       ├── prometheus.yml                     # Prometheus scrape configuration for proxy :8443
│       └── grafana/
│           ├── dashboards/                    # Pre-provisioned JSON monitoring dashboards
│           │   ├── cache.json                 # L1/L2 cache hit/miss ratio & eviction dashboard
│           │   ├── circuit-breaker.json       # Circuit breaker state transitions & drop rates
│           │   ├── load-balancer.json         # Per-upstream load distribution & active connections
│           │   ├── proxy-overview.json        # High-level RPS, latency percentiles & error rates
│           │   └── rate-limit.json            # HTTP 429 throttled requests & burst monitoring
│           └── provisioning/
│               ├── dashboards/dashboards.yaml # Dashboard provider mapping config
│               └── datasources/datasources.yaml# Prometheus datasource connection definition
│
├── docs/                                      # 22 Architectural & Technical Deep Dives
│   ├── 00-index.md                            # Documentation index & architecture map
│   ├── 01-websocket.md                        # L4 TCP tunneling, HTTP Upgrade & WS sticky sessions
│   ├── 02-tls-https.md                        # TLS termination, cert loading & HTTP 8080→8443 redirect
│   ├── 03-load-balancing.md                   # 12 load balancing strategies & NGINX WRR math
│   ├── 04-health-checks.md                    # Active HTTP ping probe & passive error event bus
│   ├── 05-rate-limiting.md                    # 5 rate-limiting algorithms & SoftLimit burst policy
│   ├── 06-circuit-breaker.md                  # Classic 3-state machine & Google SRE adaptive drop math
│   ├── 07-caching.md                          # Invalidation strategies, Vary headers & Cache-Control
│   ├── 08-master-worker-architecture.md       # Cluster IPC dispatch, worker restart & SIGTERM guard
│   ├── 09-service-registry.md                 # Dynamic registration, heartbeat & atomic disk persistence
│   ├── 10-middleware-pipeline.md              # Onion model, RequestContext & next() chaining
│   ├── 11-observability.md                    # MetricsRegistry, OpenMetrics exposition & Prometheus
│   ├── 12-https-request-flow.md               # End-to-end request lifecycle: TLS → Worker → Upstream
│   ├── 13-config-zod-validation.md            # Zod runtime schema validation & SIGHUP hot-reload
│   ├── 14-retry-bulkhead.md                   # Bulkhead slot isolation, RetryBudget & 4 jitter backoffs
│   ├── 15-connection-pool.md                  # Keep-alive agents, maxSockets: 256 & socket reuse
│   ├── 16-multi-tier-caching.md               # HybridCache: L1 RAM (<0.05ms) + L2 Redis write-through
│   ├── 17-cdc-cache-invalidation.md           # Debezium CDC streaming invalidation on SQL/Mongo writes
│   ├── 18-tracing.md                          # Distributed Tracer, span lifecycle & X-Trace-Id header
│   ├── 19-readiness-liveness.md               # ReadinessProbe multi-check gate vs Liveness checks
│   ├── 20-tenant-log-streamer.md              # Asynchronous batched webhook dispatch per tenant
│   ├── 21-deployment.md                       # Local run, cert generation & Prometheus/Grafana stack
│   └── 22-testing-strategy.md                 # 5-tier testing pyramid & strict verification philosophy
│
├── logs/                                      # Access logs & log parsing guides
│   ├── README.md                              # Combined log schema, field breakdown & awk queries
│   └── access.log                             # Live access logs with microsecond latency metrics
│
├── result/                                    # Tiered test verification artifacts
│   ├── README.md                              # Test reporting index & environment guidelines
│   ├── unit-tests/
│   │   └── README.md                          # Level 1: In-memory unit & algorithm audit scope
│   ├── smoke-tests/
│   │   └── README.md                          # Level 2: Transport & protocol smoke check specifications
│   ├── integration-tests/
│   │   └── README.md                          # Level 3: Strict 10-point real-application E2E suite
│   ├── chaos-tests/
│   │   └── README.md                          # Level 4: Fault injection, node kill & failover plans
│   ├── load-tests/
│   │   └── README.md                          # Level 5: k6 sustained RPS & P99 latency criteria
│   └── request_check_for_graf.t/
│       ├── image.png                          # Grafana metrics dashboard verification capture
│       └── request.t                          # Historical curl check logs across features
│
├── scripts/                                   # Operational & maintenance CLI utilities
│   ├── README.md                              # Utility catalog & CLI argument reference
│   ├── benchmark.ts                           # Batch HTTP/HTTPS concurrency benchmarker
│   ├── generate-certs.sh                      # Self-signed TLS cert generator (cert.pem, key.pem)
│   ├── interactive-algo-test.ts               # Interactive CLI visualizer for load balancing algorithms
│   ├── migrate-config.ts                      # Configuration schema upgrade utility
│   └── verify-all-features.ts                 # Full sequential feature verification utility
│
├── src/                                       # Core Reverse Proxy Engine
│   ├── index.ts                               # CLI entrypoint & bootstrap orchestrator
│   │
│   ├── balancer/                              # Load Balancing Subsystem
│   │   ├── index.ts                           # Load balancer module exports
│   │   ├── contracts/                         # Load balancing interfaces & types
│   │   │   ├── balancer.interface.ts          # ILoadBalancer contract definition
│   │   │   ├── context.types.ts               # Routing context & client metadata types
│   │   │   └── strategy.interface.ts          # IStrategy contract definition
│   │   ├── core/                              # Core load balancer logic
│   │   │   ├── load-balancer.ts               # LoadBalancer class with pickFiltered()
│   │   │   └── strategy-registry.ts           # Registry mapping strategy names to instances
│   │   ├── factory/                           # Strategy factory layer
│   │   │   ├── balancer.factory.ts            # Dynamic strategy instantiation from config
│   │   │   └── explain.t                      # Design notes on strategy factory pattern
│   │   └── strategies/                        # 12 Implemented Strategy Algorithms
│   │       ├── adaptive-wrr.strategy.ts       # Latency EWMA dynamic weight balancing
│   │       ├── consistent-hashing.strategy.ts # 150-virtual-node Ketama hash ring
│   │       ├── ip-hash.strategy.ts            # Deterministic FNV-1a IP modulo hash
│   │       ├── least-connections.strategy.ts  # Minimal active connection routing
│   │       ├── least-response-time.strategy.ts# EWMA latency-sensitive routing
│   │       ├── power-of-two.strategy.ts       # O(1) random two-choice selection (P2C)
│   │       ├── random.strategy.ts             # Uniform random selection fallback
│   │       ├── resource-based.strategy.ts     # Sidecar CPU/Memory telemetry-aware routing
│   │       ├── round-robin.strategy.ts        # Classic sequential round-robin
│   │       ├── sticky-sessions.strategy.ts    # Cookie-based (NINJA_ROUTE) session affinity
│   │       ├── weighted-least-connections.strategy.ts # Active connections / weight ratio
│   │       └── weighted-round-robin.strategy.ts       # Interleaved smooth NGINX WRR
│   │
│   ├── cache/                                 # Caching Subsystem
│   │   ├── index.ts                           # Cache module exports
│   │   ├── cache-manager.ts                   # Facade coordinating L1/L2 and CDC invalidators
│   │   ├── contracts/                         # Cache contracts & interfaces
│   │   │   ├── cache.interface.ts             # ICache contract (get, set, del, invalidate)
│   │   │   ├── cache-config.interface.ts      # Cache configuration types
│   │   │   └── invalidator.interface.ts       # IInvalidator contract
│   │   ├── invalidation/                      # Cache invalidation mechanisms
│   │   │   ├── debezium.invalidator.ts        # Event-driven CDC SQL/Mongo log parser
│   │   │   ├── pattern.invalidator.ts         # Wildcard glob pattern cache purger
│   │   │   └── tag.invalidator.ts             # Entity metadata tag purger
│   │   ├── policies/                          # Caching policies & parsers
│   │   │   ├── cache-control.parser.ts        # HTTP Cache-Control header parser
│   │   │   ├── key-builder.ts                 # Deterministic query-normalized cache key builder
│   │   │   ├── stale-if-error.ts              # Stale cache delivery on upstream 5xx errors
│   │   │   └── stale-while-revalidate.ts      # Background revalidation without client stalls
│   │   └── stores/                            # Cache storage implementations
│   │       ├── hybrid.cache.ts                # Two-tier orchestrator (L1 Memory + L2 Redis)
│   │       ├── in-memory-lru.ts               # Synchronous bounded LRU memory store
│   │       └── redis.cache.ts                 # Distributed Redis client adapter
│   │
│   ├── config/                                # Configuration Engine
│   │   ├── index.ts                           # Config module exports
│   │   ├── config.ts                          # Loaded config singleton
│   │   ├── config.loader.ts                   # YAML reader, environment resolver & SIGHUP reloader
│   │   ├── config-schema.ts                   # Master Zod schema
│   │   ├── server-schema.ts                   # Server sub-schema definition
│   │   └── schemas/                           # Zod Modular Schemas
│   │       ├── admin.schema.ts                # Admin API configuration schema
│   │       ├── balancer.schema.ts             # Load balancer options schema
│   │       ├── cache.schema.ts                # Cache settings schema
│   │       ├── discovery.schema.ts            # Service discovery & probe schema
│   │       ├── observability.schema.ts        # Metrics, tracing & logging schema
│   │       ├── ratelimit.schema.ts            # Rate limiter algorithms & stores schema
│   │       ├── resilience.schema.ts           # Circuit breaker, retry & bulkhead schema
│   │       └── server.schema.ts               # Server ports, TLS, workers & timeouts schema
│   │
│   ├── core/                                  # Core Cluster & Pipeline Orchestration
│   │   ├── admin/
│   │   │   └── admin.handler.ts               # Internal admin API route handler
│   │   ├── cluster/                           # Master/Worker IPC Cluster Architecture
│   │   │   ├── ipc.protocol.ts                # Master-Worker IPC message contracts
│   │   │   ├── master.ts                      # Cluster master: TLS, LB, WS routing & worker watchdog
│   │   │   └── worker.ts                      # Cluster worker: pipeline execution & upstream proxying
│   │   ├── pipeline/                          # Middleware Pipeline Execution
│   │   │   ├── context.ts                     # RequestContext factory (IP, startTime, metadata)
│   │   │   └── middleware.pipeline.ts         # Onion-model middleware pipeline runner
│   │   ├── proxy/                             # Network Proxying & Connection Pools
│   │   │   ├── connection.pool.ts             # Persistent httpAgent & httpsAgent connection pools
│   │   │   ├── http.handler.ts                # HTTP request streaming & response forwarding
│   │   │   ├── upstream.client.ts             # Upstream client request dispatcher
│   │   │   └── websocket.handler.ts           # L4 bidirectional TCP pipe tunnel for WebSockets
│   │   └── router/                            # Route Matching & Path Rules
│   │       ├── route.matcher.ts               # First-match router with method guards
│   │       ├── route.types.ts                 # RouteRule definitions & path options
│   │       └── router.ts                      # Router class abstraction
│   │
│   ├── discovery/                             # Service Discovery & Health Checking
│   │   ├── index.ts                           # Discovery module exports
│   │   ├── target-node.ts                     # Target node representation
│   │   ├── contracts/
│   │   │   └── registry.interface.ts          # IServiceRegistry interface
│   │   ├── health/                            # Health Probe Implementations
│   │   │   ├── active.probe.ts                # Periodic active HTTP ping checker (checkUpstream)
│   │   │   ├── health.manager.ts              # HealthManager tracking consecutive failure state
│   │   │   └── passive.probe.ts               # Passive traffic error event bus observer
│   │   └── registry/                          # Service Registries
│   │       └── dynamic.registry.ts            # Dynamic registry with atomic .tmp disk snapshot
│   │
│   ├── middleware/                            # Onion Middleware Pipeline Implementations
│   │   ├── auth.middleware.ts                 # Bearer token & API key authorization
│   │   ├── body-limit.middleware.ts           # Payload size ceiling enforcement
│   │   ├── cache.middleware.ts                # Cache lookup, short-circuit & response buffering
│   │   ├── circuit.middleware.ts              # Circuit breaker gating & 503 fast-fail
│   │   ├── cors.middleware.ts                 # CORS preflight & header injection
│   │   ├── logging.middleware.ts              # Access logging with microsecond timing
│   │   ├── rate-limit.middleware.ts           # Multi-dimensional rate limit enforcement
│   │   └── tracing.middleware.ts              # Trace ID extraction & span generation
│   │
│   ├── observability/                         # Observability, Telemetry & Tracing
│   │   ├── index.ts                           # Observability module exports
│   │   ├── health/
│   │   │   └── readiness.ts                   # Multi-check ReadinessProbe gating
│   │   ├── logger/                            # Logging subsystems
│   │   │   ├── logger.ts                      # Structured JSON console logger
│   │   │   └── tenant-log.streamer.ts         # Multi-tenant asynchronous webhook log dispatcher
│   │   ├── metrics/                           # Prometheus metrics
│   │   │   ├── histogram.registry.ts          # Latency histogram with bucket aggregation
│   │   │   ├── prometheus.exporter.ts         # MetricsRegistry formatting OpenMetrics exposition
│   │   │   └── system.metrics.ts              # CPU load, memory RSS & process uptime collector
│   │   └── tracing/                           # Distributed Tracing
│   │       └── tracer.ts                      # In-process Tracer managing span lifecycles
│   │
│   ├── ratelimit/                             # Rate Limiting Engine
│   │   ├── index.ts                           # Rate limit module exports
│   │   ├── rate-limiter.ts                    # RateLimiter facade
│   │   ├── algorithms/                        # 5 Rate Limiting Algorithms
│   │   │   ├── fixed-window.ts                # Discrete time-slice counter
│   │   │   ├── leaking-bucket.ts              # Constant-rate queue drain
│   │   │   ├── sliding-window-counter.ts      # Weighted previous/current window interpolation
│   │   │   ├── sliding-window-log.ts          # Exact microsecond timestamp log
│   │   │   └── token-bucket.ts                # Continuous refill token bucket with burst capacity
│   │   ├── contracts/                         # Rate limit contracts
│   │   │   ├── limiter.interface.ts           # IRateLimiterAlgorithm contract
│   │   │   └── storage.interface.ts           # IRateLimitStore contract (increment, count, reset)
│   │   ├── policies/                          # Rate limit policies
│   │   │   └── soft-limit.policy.ts           # Dynamic burst multiplier below load threshold
│   │   └── storage/                           # Rate Limit Storage Adapters
│   │       ├── hybrid.store.ts                # L1 Memory + L2 Redis fallback store
│   │       ├── memory.store.ts                # Local in-memory Map store
│   │       └── redis.store.ts                 # Atomic Redis Lua script store
│   │
│   ├── resilience/                            # Fault Tolerance & Resilience Subsystem
│   │   ├── index.ts                           # Resilience module exports
│   │   ├── bulkhead/                          # Concurrency isolation
│   │   │   └── bulkhead.ts                    # Slot-based concurrency isolation limiter
│   │   ├── circuit-breaker/                   # Circuit Breakers
│   │   │   ├── adaptive.circuit-breaker.ts    # Google SRE drop probability breaker
│   │   │   ├── circuit-breaker.manager.ts     # Singleton manager caching breakers per upstream
│   │   │   ├── classic.circuit-breaker.ts     # CLOSED → OPEN → HALF_OPEN state machine
│   │   │   ├── contracts/
│   │   │   │   └── circuit-breaker.interface.ts # ICircuitBreaker contract
│   │   │   └── states/                        # Circuit breaker states
│   │   │       ├── closed.state.ts            # ClosedState: normal traffic flow
│   │   │       ├── half-open.state.ts         # HalfOpenState: trial request probing
│   │   │       └── open.state.ts              # OpenState: fast-fail 503 rejection
│   │   └── retry/                             # Retry Engine
│   │       ├── retry-budget.ts                # Capped retry ratio budget (e.g. max 15%)
│   │       ├── retry-handler.ts               # Execution wrapper with retry policies
│   │       ├── contracts/
│   │       │   └── retry.interface.ts         # IRetryPolicy contract
│   │       └── backoff/                       # 4 Jitter Backoff Algorithms
│   │           ├── decorrelated-jitter.backoff.ts # AWS decorrelated sleep growth backoff
│   │           ├── equal-jitter.backoff.ts        # Base + random jitter backoff
│   │           ├── exponential.backoff.ts         # Deterministic exponential doubling backoff
│   │           └── full-jitter.backoff.ts         # Uniform randomized 0..cap full jitter backoff
│   │
│   └── types/                                 # Global TypeScript Type Definitions
│       ├── index.ts                           # Type exports
│       ├── balancer.types.ts                  # Load balancer types & strategy names
│       ├── common.types.ts                    # Utility types
│       ├── config.types.ts                    # Proxy configuration interfaces
│       ├── http.types.ts                      # HTTP header & request representations
│       ├── resilience.types.ts                # Circuit breaker & retry configuration types
│       └── upstream.types.ts                  # Upstream definition, health status & metrics types
│
└── tests/                                     # 5-Tier Verification Framework
    ├── README.md                              # Test pyramid documentation & runner commands
    ├── full-system-audit.mjs                  # Level 1: 183-test in-memory unit audit script
    ├── live-integration-test.mjs              # Level 2: 6-point protocol smoke test script
    ├── universal-app-test.mjs                 # Level 3: 10-point strict real-app integration test
    ├── chaos/                                 # Chaos engineering suites
    │   └── upstream-failure.chaos.ts          # Level 4: Upstream kill & failover chaos test
    ├── integration/                           # Compiled Integration Tests
    │   ├── failover.test.ts                   # Circuit breaker failover via load balancer
    │   ├── hot-reload.test.ts                 # Configuration hot-reload on SIGHUP
    │   ├── http-proxy.test.ts                 # HTTP upstream request & body routing
    │   └── websocket.test.ts                  # WebSocket upgrade tunneling
    ├── load/                                  # Load & stress testing
    │   └── k6/                                # Level 5: k6 Load & Stress Benchmark Scripts
    │       ├── smoke.js                       # 1 VU, 30s baseline sanity check
    │       ├── stress.js                      # Ramp 0 to 200 VUs over 9m sustained stress
    │       └── spike.js                       # Sudden burst surge to 500 VUs
    ├── mocks/                                 # Test Mock Factories
    │   └── target-servers.mock.ts             # Ephemeral mock HTTP server test factory
    └── unit/                                  # Compiled Unit Tests
        ├── balancer/                          # Load balancer unit tests
        │   ├── .gitkeep
        │   ├── balancerAllStrategies.test.ts  # All 12 strategy pick() tests
        │   ├── loadBalancer.test.ts           # pickFiltered() & connection tracking tests
        │   └── loadBalancerAdvanced.test.ts   # WRR math, P2C & consistent hash tests
        ├── cache/                             # Cache unit tests
        │   ├── .gitkeep
        │   ├── cache.test.ts                  # InMemoryLRU & HybridCache tests
        │   └── cacheAllFeatures.test.ts       # KeyBuilder, SWR, StaleIfError & CDC tests
        ├── discovery/                         # Discovery unit tests
        │   ├── .gitkeep
        │   ├── discovery.test.ts              # ServiceRegistry & ActiveProbe tests
        │   └── discoveryAllFeatures.test.ts   # PassiveProbe & disk snapshot tests
        ├── observability/                     # Observability unit tests
        │   └── observabilityAllFeatures.test.ts # Histograms, MetricsRegistry & log streamer tests
        ├── ratelimit/                         # Rate limit unit tests
        │   ├── .gitkeep
        │   ├── rateLimitAllAlgorithms.test.ts # All 5 algorithms & SoftLimitPolicy tests
        │   └── rateLimiter.test.ts            # RateLimiter facade & memory store tests
        └── resilience/                        # Resilience unit tests
            ├── .gitkeep
            ├── circuitBreaker.test.ts         # ClassicCB & AdaptiveCB tests
            ├── resilience.test.ts             # Bulkhead & retry handler tests
            └── resilienceAllFeatures.test.ts  # All 4 jitter backoffs & RetryBudget tests
```

---

## ⚡ Core Systems & Features

### 1. Advanced Load Balancing Engine (12 Strategies)
All load balancing strategies are dynamically validated using Zod schemas and instantiated via `BalancerFactory`:

* **Weighted Round-Robin (WRR)**: Smooth interleaved scheduling (NGINX style) using `currentWeight` adjustments.
* **Adaptive Weighted Round-Robin**: Automatically modifies weights in real time based on latency EWMA and request error rates.
* **Power of Two Choices (P2C)**: Pick two random healthy upstreams and route to the one with the lowest active connections ($O(1)$ efficiency).
* **Least Connections**: Route to the healthy upstream with the fewest active connections.
* **Weighted Least Connections**: Select using the `activeConnections / weight` ratio.
* **Least Response Time**: Route using latency EWMA (Exponentially Weighted Moving Average).
* **Consistent Hashing**: Distributed virtual node (150 replicas) ring mapping client IP to upstreams with minimum cache eviction.
* **IP Hash**: FNV-1a hash-modulo routing using client IP.
* **Sticky Sessions**: Cookie-based (`NINJA_ROUTE`) session affinity.
* **Resource-Based**: Telemetry-aware load routing using live CPU and memory metrics reported by sidecars.
* **Random Selection**: Fallback randomized distribution.

---

### 2. High-Performance Multi-Tier Caching & Invalidation
* **L1/L2 Hybrid Caching**: In-memory LRU cache (L1 RAM) backed by Redis (L2 Distributed Store) with automatic L1 warming & background synchronization.
* **Debezium CDC (Change Data Capture) Invalidation**: Subscribes to Redis Pub/Sub events from Debezium Server. Parses transaction log updates from SQL databases and MongoDB (supporting ObjectId `$oid` conversions) to invalidate cached paths instantly:
  * *SQL Event Map*: `{"op":"u", "source":{"table":"orders"}, "after":{"id":999}}` $\rightarrow$ Invalidates `/api/orders/999`.
  * *Mongo Event Map*: `{"op":"u", "source":{"collection":"orders"}, "after":{"_id":{"$oid":"60d5ec4b..."}}}` $\rightarrow$ Invalidates matching mapped paths.
* **Pattern & Tag-Based Invalidation**: Glob pattern matching (`PatternInvalidator`) and metadata grouping (`TagInvalidator`).
* **Cache Control Directives (`CacheControlParser`)**: Parses standards-compliant HTTP headers (`no-store`, `no-cache`, `max-age`, `s-maxage`, `private`).
* **Cache Normalization (`KeyBuilder`)**: Strips marketing query parameters (`utm_source`, `fbclid`) and handles `Vary` headers (`Accept-Encoding: gzip`).
* **Advanced Cache Policies**:
  * `stale-while-revalidate`: Serves stale cache while triggering concurrent lock-free background revalidation (preventing Thundering Herd / Cache Stampedes).
  * `stale-if-error`: Serves expired stale cache during upstream 5xx or network outages.

---

### 3. Distributed Rate Limiting & Throttling
* **5 Algorithms**: `token-bucket`, `leaking-bucket`, `fixed-window`, `sliding-window-log`, and `sliding-window-counter`.
* **Atomic Redis Lua Scripts**: Server-side Lua script execution preventing race conditions across distributed proxy nodes.
* **Soft Limit Warning & Burst Policy**: Dynamically increases burst limit ($1.5\times$ base limit) when current system load is below soft threshold.
* **Multi-Dimension Rules**: Independent rate limiting rules evaluated per IP, Route, API-Key, and Header combination (`rl:ip:/api/v1:10.0.0.1`).

---

### 4. Advanced Fault Tolerance & Resilience
* **Classic Circuit Breaker**: Standard state machine (`CLOSED` $\rightarrow$ `OPEN` $\rightarrow$ `HALF_OPEN`) based on consecutive failure thresholds.
* **Google SRE EWMA Adaptive Circuit Breaker**: Rate-based shedding model using Google SRE probability math:
  $$P = \frac{\text{requests} - K \times \text{accepts}}{\text{requests} + 1}$$
* **Bulkhead Pattern**: Concurrency isolation slots preventing slow upstreams from exhausting worker thread pools.
* **4 Jitter Backoff Algorithms**:
  * `ExponentialBackoff`: Deterministic doubling.
  * `FullJitterBackoff`: $Random(0, min(cap, base \times 2^{attempt}))$.
  * `EqualJitterBackoff`: $\frac{temp}{2} + Random(0, \frac{temp}{2})$.
  * `DecorrelatedJitterBackoff`: $Random(base, previousSleep \times 3)$.
* **Retry Budgets**: Capped retry allowance (e.g. max 15% retry budget) to prevent upstream retry storms.

---

### 5. Dynamic Service Registry & Health Probes
* **Dynamic Self-Registration REST API**: Upstreams can self-register, heartbeat, and deregister (`/__registry/register`, `heartbeat`, `deregister`).
* **Disk Snapshot Persistence**: Automatic rehydration of services from `registry.json` snapshot backups on proxy restart.
* **Dual Health Probes**: Active HTTP ping probes (`checkUpstream`) + Passive background failure monitors.

---

### 6. Observability, Telemetry & Multi-Tenant Logging
* **Prometheus Exposition Endpoint (`/metrics`)**: Exposes latency percentiles (P50, P95, P99), RPS, active connections, and circuit breaker status.
* **5 Auto-Provisioned Grafana Dashboards**: Visual monitoring dashboards for Proxy Overview, Load Balancers, Cache, Circuit Breakers, and Rate Limiters.
* **Tenant Log Streamer**: Webhook log streaming engine dispatching structured JSON access logs to tenant HTTP webhooks.

---

## 📄 Complete Production `config.yaml` Reference

```yaml
server:
  host: "0.0.0.0"
  port: 8080
  httpsPort: 8443
  workers: 4

upstreams:
  - id: "app-node-1"
    url: "http://127.0.0.1:3000"
    weight: 3
    maxConnections: 500
    healthPath: "/health"
  - id: "app-node-2"
    url: "http://127.0.0.1:3001"
    weight: 1
    maxConnections: 500
    healthPath: "/health"

loadBalancing:
  strategy: "weighted-round-robin"  # Options: round-robin, least-connections, power-of-two, consistent-hashing, adaptive-wrr, resource-based
  stickyCookieName: "NINJA_ROUTE"

rateLimit:
  enabled: true
  storage: "memory"                 # Options: memory, redis, hybrid
  algorithm: "token-bucket"         # Options: fixed-window, sliding-window-log, sliding-window-counter, token-bucket, leaking-bucket
  windowMs: 60000
  maxRequests: 1000
  softLimit: true
  dimensions:
    - dimension: "ip"
      maxRequests: 100
      windowMs: 60000
    - dimension: "api-key"
      maxRequests: 500
      windowMs: 60000

cache:
  enabled: true
  ttlSeconds: 60
  l1MaxSize: 1000
  staleWhileRevalidate: true
  staleIfError: true
  debezium:
    enabled: true
    channel: "debezium-cdc-events"
    mappings:
      - table: "orders"
        pathPattern: "/api/orders/{id}"

resilience:
  circuitBreaker:
    mode: "adaptive"                # Options: classic, adaptive
    failureThreshold: 3
    recoveryTimeMs: 10000
  bulkhead:
    maxConcurrent: 100
  retry:
    maxAttempts: 3
    backoff: "full-jitter"          # Options: exponential, full-jitter, equal-jitter, decorrelated-jitter

observability:
  metrics:
    enabled: true
    path: "/metrics"
```

---

## 📚 Complete Technical Documentation

Comprehensive architectural deep-dives with ASCII diagrams, code flows, and configuration references are available in the [`docs/`](./docs/00-index.md) directory:

| # | Topic | Document |
|---|---|---|
| **01** | WebSocket Proxying | [01-websocket.md](./docs/01-websocket.md) |
| **02** | TLS & HTTPS Termination | [02-tls-https.md](./docs/02-tls-https.md) |
| **03** | 12 Load Balancing Strategies | [03-load-balancing.md](./docs/03-load-balancing.md) |
| **04** | Active & Passive Health Checks | [04-health-checks.md](./docs/04-health-checks.md) |
| **05** | 5 Rate Limiting Algorithms | [05-rate-limiting.md](./docs/05-rate-limiting.md) |
| **06** | Classic & Adaptive Circuit Breakers | [06-circuit-breaker.md](./docs/06-circuit-breaker.md) |
| **07** | High-Performance Caching & Invalidation | [07-caching.md](./docs/07-caching.md) |
| **08** | Master-Worker Cluster Architecture | [08-master-worker-architecture.md](./docs/08-master-worker-architecture.md) |
| **09** | Dynamic Service Registry | [09-service-registry.md](./docs/09-service-registry.md) |
| **10** | Onion Middleware Pipeline | [10-middleware-pipeline.md](./docs/10-middleware-pipeline.md) |
| **11** | Observability, Prometheus & Grafana | [11-observability.md](./docs/11-observability.md) |
| **12** | Complete HTTPS Request Flow | [12-https-request-flow.md](./docs/12-https-request-flow.md) |
| **13** | Zod Schema Configuration Validation | [13-config-zod-validation.md](./docs/13-config-zod-validation.md) |
| **14** | Retry Handler, Budget & Bulkhead | [14-retry-bulkhead.md](./docs/14-retry-bulkhead.md) |
| **15** | Connection Pooling & Socket Reuse | [15-connection-pool.md](./docs/15-connection-pool.md) |
| **16** | Two-Tier Caching (L1 RAM + L2 Redis) | [16-multi-tier-caching.md](./docs/16-multi-tier-caching.md) |
| **17** | Event-Driven CDC Invalidation (Debezium) | [17-cdc-cache-invalidation.md](./docs/17-cdc-cache-invalidation.md) |
| **18** | Distributed Tracing & Correlation IDs | [18-tracing.md](./docs/18-tracing.md) |
| **19** | Health Gating: Readiness vs Liveness | [19-readiness-liveness.md](./docs/19-readiness-liveness.md) |
| **20** | Multi-Tenant Log Streaming Webhooks | [20-tenant-log-streamer.md](./docs/20-tenant-log-streamer.md) |
| **21** | Operations & Deployment Guide | [21-deployment.md](./docs/21-deployment.md) |
| **22** | Testing Architecture & Strategy | [22-testing-strategy.md](./docs/22-testing-strategy.md) |

---

## 🧪 Testing & Verification Suites

Ninja Reverse Proxy follows a strict testing pyramid to ensure zero unhandled socket leaks or runtime crashes before load testing:

### 1. In-Memory Unit & Subsystem Audit (183 Tests)
Runs in-memory with zero network overhead. Validates every algorithm, mathematical formula, state machine, and data structure:
```bash
npm run test:audit
```

### 2. Protocol & Network Transport Smoke Test (6 Checks)
Validates port 8080 $\to$ 8443 auto-redirect, TLS socket negotiation, basic WebSocket 101 upgrade, and live Prometheus scrape:
```bash
npm run test:live
```

### 3. Strict Real-App Integration Suite (10 Checks)
Zero shortcuts. Tests real HTML delivery, CORS preflight, distributed trace headers, 4-hit sticky session pinning, Socket.IO tunneling, slow backend tolerance (`/slow`), automatic retry on flaky upstreams (`/flake`), and 30-request concurrency burst against live backends:
```bash
npm run test:universal
```

### 4. Hyperscale Load & Stress Benchmark (Up to 1,000 VUs)
Benchmarked under authentic multi-method traffic (GET catalog queries, POST JSON orders, PUT mutations, Bearer JWT auth, and rate limiter clamping) using **Power of Two Choices (P2C)** across 4 backend nodes:

```bash
# Run the automated 10-stage hyperscale suite:
node tests/load/load-runner.mjs
```

#### 📊 Verified Benchmark Key Results (Apple M5 10-Core, 6 Clustered Workers)
| Scenario Milestone | Concurrency (VUs) | Workload Profile | Throughput (RPS) | Total Requests | Latency P50 | Latency P99 | Error Rate | Status |
|---|---|---|---|---|---|---|---|---|
| **Baseline Overhead** | **100 VUs** | `ecommerce_mix` | **3,913.4 req/s** | 39,305 | `21.19ms` | `92.15ms` | **0.00%** | ✅ PASS |
| **Production Scale** | **300 VUs** | `ecommerce_mix` | **5,421.7 req/s** | 54,475 | `51.35ms` | `123.12ms` | **0.00%** | ✅ PASS |
| **High Concurrency** | **500 VUs** | `ecommerce_mix` | **6,650.1 req/s** | 53,389 | `73.65ms` | `135.52ms` | **0.00%** | ✅ PASS |
| **Peak Hyperscale Ceiling**| **1,000 VUs** | `ecommerce_mix` | **5,992.8 req/s** | 48,176 | `155.08ms` | `327.38ms` | **0.00%** | ✅ PASS |
| **Sliding Window Defense** | **500 VUs** | `rate_limited_sliding_window` | **17,750.8 req/s** | 142,421 | `20.85ms` | `96.57ms` | **0.00%** | ✅ PASS |
| **DDoS Saturation Spike** | **1,000 VUs** | `ddos_burst` | **13,685.7 req/s** | 82,641 | `61.02ms` | `223.28ms` | **0.00%** | ✅ PASS |

> **Grand Totals**: **627,212 Requests Processed** | **Peak Throughput: 17,750 req/s** | **Errors: 0.00%** | **Max Memory: 150 MB**

#### 🔬 Local Machine Bottleneck vs Cloud Scaling Capacity:
- **Current Local Ceiling (~1,500 – 2,000 VUs)**: On a single development machine, the client load generator, the 6 proxy workers, and the 4 backend mock servers all share the same physical CPU and loopback network stack (`127.0.0.1`), competing for OS ephemeral ports and socket buffers.
- **Distributed Cloud Capacity (10,000 – 50,000+ VUs)**: When deployed in Kubernetes or AWS/GCP with dedicated client nodes and isolated backend pods, the proxy's non-blocking epoll/kqueue event loop can easily handle **tens of thousands of concurrent connections** without local loopback contention.

👉 **[View Full In-Depth Benchmark Report (10 Stages)](./result/load-tests/load-test-report.md)**  
👉 **[View Subsystem & Algorithm Architecture Trade-Off Guide](./result/load-tests/algorithm-tradeoffs.md)**  
👉 **[View Raw JSON Telemetry Data](./result/load-tests/load_test_results.json)**

---

## 📦 Build & Run

```bash
# 1. Install dependencies
pnpm install

# 2. Build TypeScript bundle to dist/
npm run build

# 3. Generate self-signed TLS certificates (dev)
npm run generate-certs

# 4. Start Proxy in Production Mode
npm start

# 5. Start Proxy with Watch/Hot-Reload Mode
npm run dev
```

---

## 📜 License

MIT License © 2026 Praveen Kumar