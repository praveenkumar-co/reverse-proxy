# Ninja Reverse Proxy

A production-grade, backend-agnostic **Layer 7 Reverse Proxy & Load Balancer** built from scratch in TypeScript and Node.js. 

Designed in the same philosophy as Nginx, Traefik, and HAProxy — configure it once, point it at any backend, and it handles routing, load balancing, rate limiting, caching, and health checks automatically.

---

## Architecture Overview

Ninja Reverse Proxy utilizes a highly scalable **Master/Worker Cluster Architecture** that runs on all available CPU cores.

```
                     +----------------------------+
                     |        Client (WS/HTTPS)   |
                     +--------------+-------------+
                                    |
                                    ▼
                     +----------------------------+
                     |    Master Node (Terminates)|
                     +-------+------------+-------+
                             |            |
                    (IPC Chans)          (IPC Chans)
                             |            |
            +----------------v---+    +---v----------------+
            | Worker 1           |    | Worker 2           |
            | - HTTP/WS Handlers |    | - HTTP/WS Handlers |
            | - Hybrid L1 LRU    |    | - Hybrid L1 LRU    |
            +-------+------------+    +---+----------------+
                    |                     |
             (TCP/WSS Proxy)       (TCP/WSS Proxy)
                    |                     |
      +-------------v---------------------v-------------+
      |  Shared Distributed Tier:                       |
      |  - L2 Response Cache (Redis)                    |
      |  - Distributed Rate Limiter State (Redis)       |
      |  - Telemetry & Dynamic Service Registry         |
      +------+------------------------------------+-----+
             |                                    |
             ▼                                    ▼
      +--------------+                     +--------------+
      | Upstream A   |                     | Upstream B   |
      +--------------+                     +--------------+
```

---

## Directory Structure

The codebase is organized in an enterprise-grade modular directory structure:

```
ninja-proxy/
├── .github/workflows/          # CI/CD Workflows (ci, release, security, load tests)
├── deploy/
│   ├── docker/                 # Container files (Dockerfile, Dev, Distroless)
│   ├── k8s/                    # Kubernetes resources (Base, Overlays, Secrets)
│   └── monitoring/             # Prometheus, Alertmanager, and Grafana configs
├── docs/                       # Architecture and operational guides
├── scripts/                    # Scripts for cert generation, benchmarks, migrations
├── src/
│   ├── index.ts                # Main entry point
│   ├── server.ts               # TLS / HTTP Server startup logic
│   ├── balancer/               # Load balancing contracts, strategies, factory, core
│   ├── resilience/             # Circuit Breakers, Jitter backoff retries, and Bulkheads
│   ├── ratelimit/              # Rate limit algorithms, storage, policies, middleware
│   ├── cache/                  # Response caching stores, invalidators, and policies
│   ├── discovery/              # Service registry, active/passive probes, and nodes
│   ├── core/                   # Transport & runtime pipeline (cluster, proxy, router)
│   ├── middleware/             # Pipeline middleware handlers
│   ├── config/                 # Schemas (Zod validation) & Config loader
│   ├── observability/          # Prometheus exporter, metrics, structured logger, tracer
│   └── types/                  # Share type definitions
└── tests/                      # Unit, Integration, Chaos, and Load testing suites
```

---

## Advanced Features & Core Concepts

### 1. Advanced Load Balancing (11 Strategies)
All strategies are dynamically validated using Zod schemas and instantiated via a centralized factory:
*   **Weighted Round-Robin (WRR)**: Smooth interleaved scheduling (Nginx style) using `currentWeight` adjustments.
*   **Adaptive Weighted Round-Robin**: Automatically modifies weights in real time based on latency EWMA and request error rates.
*   **Power of Two Choices (P2C)**: Pick two random healthy upstreams and route to the one with the lowest active connections.
*   **Least Connections**: Route to the healthy upstream with the fewest active connections.
*   **Weighted Least Connections**: Select using the `activeConnections / weight` ratio.
*   **Least Response Time**: Route using latency EWMA (Exponentially Weighted Moving Average).
*   **Consistent Hashing**: Distributed virtual node (150 replicas) ring mapping client IP to upstreams.
*   **IP Hash**: FNV-1a hash-modulo routing using client IP.
*   **Sticky Sessions**: Cookie-based (`NINJA_ROUTE`) session affinity.
*   **Resource-Based**: Telemetry-aware load routing using live CPU and memory metrics.
*   **Random Selection**: Fallback randomized distribution.

### 2. High-Performance Caching Tier
*   **L1/L2 Hybrid Caching**: In-memory LRU cache (L1) backed by Redis (L2) to reduce response latencies.
*   **Debezium CDC Invalidation**: Subscribes to Redis Pub/Sub events from Debezium Server. Parses transaction log updates from SQL databases and MongoDB (supporting ObjectId `$oid` conversions) to invalidate cached paths instantly:
    *   *SQL Event Map*: `{"op":"u", "source":{"table":"items"}, "after":{"id":123}}` invalidates `/api/items/123`.
    *   *Mongo Event Map*: `{"op":"u", "source":{"collection":"items"}, "after":{"_id":{"$oid":"..."}}}` invalidates matching mapped paths.
*   **Cache Policies**: Full support for `stale-while-revalidate` (concurrent background fetches) and `stale-if-error` (serving expired content on upstream failure).

### 3. Distributed Rate Limiting
*   **5 Algorithms**: Fixed Window, Sliding Window Log, Sliding Window Counter, Token Bucket, and Leaking Bucket.
*   **Hybrid Storage**: Redis distributed state storage with a fully decoupled in-memory fallback (graceful degradation).
*   **Dimension Policies**: Soft limits with burst buffers and multi-dimensional tracking (IP, API Key, Route, Headers).

### 4. Advanced Fault Tolerance
*   **SRE Adaptive Throttling**: Rate-based request shedding based on client requests vs accepted requests to handle spikes.
*   **Circuit Breakers**: Dual-mode classic consecutive error threshold breakers and SRE adaptive throttlers.
*   **Backoff Jitter Retry Logic**: Error classification distinguishing local failures (instant failover retry) from global congestion failures (Exponential Backoff with Full Jitter retry: `Sleep = Random(0, min(max, base * 2^attempt))`).
*   **Retry Budgets**: Capped retries (e.g. max 15% budget) to prevent upstream retry storms.

### 5. Dynamic Service Registry
*   Backends can dynamically self-register, deregister, and send heartbeat signals to the proxy.
*   **Registry Recovery**: Automatic rehydration of services from persistent disk backups on restart.

---

## Quick Start

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Generate TLS Certificates
```bash
pnpm run generate-certs
# Or run the script directly:
bash scripts/generate-certs.sh
```

### 3. Configure the Proxy
An annotated reference config is available at `config.example.yaml`. Here is a basic `config.yaml`:
```yaml
server:
  listen: 8080
  httpsPort: 8443
  workers: 2

  loadBalancing:
    strategy: weighted-round-robin
    failureThreshold: 3
    recoveryTimeMs: 15000
    retry:
      maxAttempts: 2
      statusCodes: [502, 503, 504]

  upstreams:
    - id: my-api-1
      url: http://localhost:5000
      weight: 3
    - id: my-api-2
      url: http://localhost:5001
      weight: 1

  paths:
    - path: /
      upstream: [my-api-1, my-api-2]
```

### 4. Run the Proxy
Compile the codebase and start the application:
```bash
# Build production bundle
pnpm run build

# Start proxy
pnpm start --config config.yaml
```

---

## Dynamic Service Registry API

Backends can register dynamically at runtime:

```bash
# Register a new upstream
curl -X POST -H "Content-Type: application/json" \
  -d '{"id":"my-service","url":"http://localhost:3000","metadata":{"cpu":"0.2","memory":"0.3"}}' \
  http://localhost:8080/__registry/register

# Send a heartbeat
curl -X PUT http://localhost:8080/__registry/heartbeat/my-service

# Deregister
curl -X DELETE http://localhost:8080/__registry/deregister/my-service
```

---

## Admin & Observability Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/__lb-stats` | GET | Load balancer configuration and metrics per upstream |
| `/__cache-stats` | GET | Cache hit/miss metrics and size |
| `/__registry` | GET | List of all registered services and heartbeats |
| `/metrics` | GET | Prometheus metrics (traffic, latency, and CPU/Memory) |

---

## Testing

Run the native test suite (including unit and advanced load balancing tests):
```bash
pnpm test
```

---

## License

MIT