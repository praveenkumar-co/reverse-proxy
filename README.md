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

## 🧪 Testing & Verification Suites

### 1. Run Complete 63-Unit & Integration Test Suite
```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test dist-test/tests/unit/**/*.js dist-test/tests/integration/*.js
```

### 2. Run 30-Feature Audit & Report Generator
```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json && node dist-test/scripts/verify-all-features.js
```
*(Generates markdown proof report in `results/interview_proof_report.md`)*

### 3. Run Production High-RPS Benchmark
```bash
npx tsx scripts/benchmark.ts https://localhost:8443/ 1000 20
```

---

## 📦 Build & NPM Publish

```bash
# Build TypeScript bundle to dist/
pnpm run build

# Publish to npmjs.com
npm publish
```

---

## 📜 License

MIT License © 2026 Praveen Kumar