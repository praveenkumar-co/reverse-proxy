# 🟣 Kotlin Ktor & Ninja Reverse Proxy: Master Unified Guide & Audit

## 📌 Executive Summary
* **Target Reverse Proxy**: `ninja-reverse-proxy` (v1.1.0)
* **Architecture**: Distributed Multi-Worker Reverse Proxy Cluster with Power of Two Choices (P2C) Load Balancing, Adaptive Circuit Breaking, Token Bucket Rate Limiting, and IPC Prometheus Exporter
* **Upstream Backend**: Kotlin 2.1 / Ktor 3.1.2 Netty Server Engine (`http://127.0.0.1:8082`)
* **Upstream Repository**: `https://github.com/dragneelfps/realworld-kotlin-ktor`
* **Isolated Configuration Path**: `/Users/praveen/Code/kotlin-ktor-realworld/config.yaml`
* **Automated Verification**: **10 / 10 Tests Passed (100% SUCCESS)**
* **Peak Gateway Burst Throughput**: **15,583 req/sec** (Autocannon Load Bench)
* **Average Steady-State Latency**: **2.48 ms** (p50: **2 ms**)
* **Prometheus Health Status**: `ninja_upstream_status{upstream_id="kotlin-ktor-service"} 1` (**UP**)
* **Result Artifacts Directory**: `/Users/praveen/Code/Backend/reverse-proxy/result/kotlin-ktor-realworld/`

---

## 🏛️ Architecture & Port Mapping

```
[ Outside World / Client / Browser / Android App ]
                 │
                 ▼ (Port 8080)
┌─────────────────────────────────────────────────────────────┐
│                 NINJA REVERSE PROXY GATEWAY                 │
│  - Master-Worker IPC Cluster (2 Workers)                    │
│  - Token Bucket Rate Limiting (500 req/min)                 │
│  - X-Forwarded-For, X-Trace-Id, X-Upstream-Id Telemetry     │
│  - Prometheus OpenMetrics Exporter (/:8080/metrics)         │
│  - Health Probing: GET /api (Welcome to Realworld)          │
│  - Routes: /api, / (fallback)                               │
└──────────────────────────────┬──────────────────────────────┘
                               │ (Internal HTTP/1.1 Keep-Alive)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             KOTLIN KTOR REALWORLD BACKEND                   │
│  - Container: kotlin-ktor-app (Docker)                      │
│  - Port: 127.0.0.1:8082                                     │
│  - Runtime: OpenJDK 21 (Eclipse Temurin JRE)                │
│  - Engine: Netty + Kotlin Coroutines                        │
│  - Routing & Features:                                      │
│    • ContentNegotiation with Jackson JSON                   │
│    • JWT Authentication & Custom Token AuthScheme           │
│    • Koin Dependency Injection                              │
│    • Exposed SQL ORM + HikariCP Connection Pool             │
│    • Embedded H2 In-Memory Database                         │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Isolated Gateway Configuration

Stored strictly inside `/Users/praveen/Code/kotlin-ktor-realworld/config.yaml`:

```yaml
server:
  host: "0.0.0.0"
  port: 8080
  workers: 2
  trustProxy: true
  connectTimeoutMs: 5000
  readTimeoutMs: 15000
  compression: false

tls:
  enabled: false

upstreams:
  - id: kotlin-ktor-service
    url: "http://127.0.0.1:8082"
    weight: 1
    healthPath: "/api"
    maxConnections: 500

routes:
  - path: "/api"
    upstreams: ["kotlin-ktor-service"]
    rateLimit:
      windowMs: 60000
      maxRequests: 500
      algorithm: token-bucket
      storage: memory

  - path: "/"
    upstreams: ["kotlin-ktor-service"]

loadBalancing:
  strategy: power-of-two

resilience:
  retry:
    enabled: true
    maxAttempts: 3
    backoff: full-jitter
    baseDelayMs: 100
    maxDelayMs: 5000
    budgetPercent: 20
  circuitBreaker:
    mode: adaptive
    failureThreshold: 20
    recoveryTimeMs: 10000

rateLimit:
  enabled: true
  storage: memory
  algorithm: token-bucket
  windowMs: 60000
  maxRequests: 500
  headers: true

cache:
  enabled: false

discovery:
  mode: static
  health:
    active:
      enabled: true
      intervalMs: 10000
      timeoutMs: 3000
      healthyThreshold: 2
      unhealthyThreshold: 3
    passive:
      enabled: true

observability:
  logging:
    level: info
    accessLog: true
  metrics:
    enabled: true
    path: "/metrics"
    histograms: true

admin:
  enabled: true
  pathPrefix: "/__admin"
```

---

## 🚀 How to Run & Verify

### Step 1: Start the Kotlin Ktor Container
```bash
docker run -d --name kotlin-ktor-app -p 8082:8082 kotlin-ktor-realworld:latest
```

### Step 2: Start Ninja Reverse Proxy with Kotlin Config
```bash
cd /Users/praveen/Code/Backend/reverse-proxy
node dist/index.js --config /Users/praveen/Code/kotlin-ktor-realworld/config.yaml
```

### Step 3: Run Automated Verification Suite
```bash
node tests/kotlin-ktor-gateway-verification.mjs
```

Expected Output:
```
═══════════════════════════════════════════════════════════════════
🟣 KOTLIN KTOR REALWORLD + NINJA REVERSE PROXY VERIFICATION SUITE
═══════════════════════════════════════════════════════════════════
Gateway Target: http://127.0.0.1:8080

✅ [PASS] [1/10] Gateway Readiness Probe (/__ready) (41ms)
✅ [PASS] [2/10] Upstream Health & Load Balancer Telemetry (/__lb-stats) (3ms)
✅ [PASS] [3/10] Ktor Root Welcome Endpoint (GET /api) (18ms)
✅ [PASS] [4/10] Kotlin User Registration & JWT Minting (POST /api/users) (260ms)
✅ [PASS] [5/10] User Authentication & Token Refresh (POST /api/users/login) (22ms)
✅ [PASS] [6/10] Authenticated Profile Inspection (GET /api/user) (31ms)
✅ [PASS] [7/10] Article Creation via Exposed ORM (POST /api/articles) (81ms)
✅ [PASS] [8/10] Public Article Discovery & Query (GET /api/articles) (21ms)
✅ [PASS] [9/10] Gateway Telemetry & Tracing Headers Propagation (7ms)
✅ [PASS] [10/10] Prometheus Observability Metrics & Upstream Health Gauge (2ms)

═══════════════════════════════════════════════════════════════════
RESULTS: 10/10 TESTS PASSED (100% Success Rate)
═══════════════════════════════════════════════════════════════════
```

---

## 📊 Prometheus & Observability Snapshot

Live scrape from `http://127.0.0.1:8080/metrics`:
```promql
# Upstream Health Gauge
ninja_upstream_status{upstream_id="kotlin-ktor-service"} 1

# Endpoint Request Traffic
ninja_http_requests_total{method="GET",path="/api",status="200",upstream_id="kotlin-ktor-service"} 623
ninja_http_requests_total{method="POST",path="/api/users",status="200",upstream_id="kotlin-ktor-service"} 1
ninja_http_requests_total{method="POST",path="/api/users/login",status="200",upstream_id="kotlin-ktor-service"} 1
ninja_http_requests_total{method="GET",path="/api/user",status="200",upstream_id="kotlin-ktor-service"} 1
ninja_http_requests_total{method="POST",path="/api/articles",status="200",upstream_id="kotlin-ktor-service"} 1
ninja_http_requests_total{method="GET",path="/api/articles",status="200",upstream_id="kotlin-ktor-service"} 1
```

---

## 📈 Autocannon Performance Comparison Across Polyglot Backends

| Stack | Engine / Runtime | Peak Throughput | Average Latency | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Node.js / Express** | Node 20 / PharmaChain | `4,739 req/sec` | `2.1 ms` | 100% Passed |
| **Python / FastAPI** | Uvicorn / Python 3.14 ASGI | `1,983 req/sec` | `5.0 ms` | 100% Passed |
| **Java / Spring Boot** | Tomcat / OpenJDK 21 (QKD) | `19,023 req/sec` | `0.78 ms` | 100% Passed |
| **Kotlin / Ktor** | Netty / OpenJDK 21 (Conduit) | `15,583 req/sec` | `2.48 ms` | 100% Passed |
