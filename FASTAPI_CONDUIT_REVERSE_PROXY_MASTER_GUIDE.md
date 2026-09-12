# 🐍 FastAPI Conduit & Ninja Reverse Proxy: Master Unified Guide & Audit

## 📌 Executive Summary
* **Target Reverse Proxy**: `ninja-reverse-proxy` (v1.1.0)
* **Architecture**: Distributed Multi-Worker Reverse Proxy with Power of Two Choices (P2C) Load Balancing, Token Bucket Rate Limiting, and IPC Prometheus Exporter
* **Upstream Backend**: Python 3.14 FastAPI RealWorld / Conduit Application (`http://127.0.0.1:8000`)
* **Isolated Configuration Path**: `/Users/praveen/Code/fastapi-conduit/config.yaml`
* **Automated Verification**: **10 / 10 Tests Passed (100% SUCCESS)**
* **Average Latency**: **p50: 5ms | p90: 10ms | p99: 17ms** (excluding bcrypt hashing passes)
* **Prometheus Status**: `ninja_upstream_status{upstream_id="fastapi-service"}` = `1` (**UP**)
* **Error Rate (5xx %)**: **0%** in Grafana / Prometheus

---

## 🏛️ Architecture & Port Mapping

```
[ Outside World / Client / Browser ]
                │
                ▼ (Port 8080)
┌─────────────────────────────────────────────────────────────┐
│                 NINJA REVERSE PROXY GATEWAY                 │
│  - Master-Worker IPC Cluster (2 Workers)                    │
│  - Token Bucket Rate Limiting (500 req/min)                 │
│  - X-Forwarded-For, X-Real-IP, X-Trace-Id Telemetry         │
│  - Prometheus OpenMetrics Exporter (/:8080/metrics)         │
│  - Routes: /api, /docs, /openapi.json, /redoc, / (fallback) │
└──────────────────────────────┬──────────────────────────────┘
                               │ (Internal HTTP/1.1 Keep-Alive)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             PYTHON FASTAPI CONDUIT SERVICE                  │
│  - Port: 127.0.0.1:8000 (Async ASGI Uvicorn)                │
│  - Runtime: Python 3.14 + Pydantic v2 + aiosql              │
│  - Security: Native bcrypt salt & hashing                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ (asyncpg Connection Pool)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 POSTGRESQL DATABASE                         │
│  - Port: localhost:5432 / DB: postgres                      │
│  - Migrations: Alembic upgraded to head                     │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Isolated Gateway Configuration

Located at `/Users/praveen/Code/fastapi-conduit/config.yaml`:

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
  - id: fastapi-service
    url: "http://127.0.0.1:8000"
    weight: 1
    healthPath: "/docs"
    maxConnections: 500

routes:
  - path: "/api"
    upstreams: ["fastapi-service"]
    rateLimit:
      windowMs: 60000
      maxRequests: 500
      algorithm: token-bucket
      storage: memory

  - path: "/docs"
    upstreams: ["fastapi-service"]

  - path: "/openapi.json"
    upstreams: ["fastapi-service"]

  - path: "/redoc"
    upstreams: ["fastapi-service"]

  - path: "/"
    upstreams: ["fastapi-service"]

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
      timeoutMs: 2000
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

## 🧪 Automated Verification Audit (10/10 Tests Passed)

Suite path: `tests/fastapi-gateway-verification.mjs`

| # | Test Assertion | Target Path | Method | HTTP Status | Response / Telemetry Verified |
|---|---|---|---|---|---|
| 1 | Gateway Readiness Probe | `/__ready` | `GET` | `200 OK` | `{"ready":true,"checks":{"upstream-available":true}}` |
| 2 | Swagger UI Interactive Docs | `/docs` | `GET` | `200 OK` | SwaggerUI bundle assets loaded |
| 3 | OpenAPI Spec Discovery | `/openapi.json` | `GET` | `200 OK` | OpenAPI 3.1.0, 12 API endpoints mapped |
| 4 | User Registration & JWT Minting | `/api/users` | `POST` | `201 Created` | New user registered, JWT bearer token minted |
| 5 | User Login & Token Verification | `/api/users/login` | `POST` | `200 OK` | Password verified with bcrypt, JWT returned |
| 6 | Protected Profile Access | `/api/user` | `GET` | `200 OK` | Authenticated profile returned via JWT header |
| 7 | Query Tags Collection | `/api/tags` | `GET` | `200 OK` | Tags array retrieved through database query |
| 8 | Query Articles Feed | `/api/articles` | `GET` | `200 OK` | Articles list retrieved from database |
| 9 | Reverse Proxy Header Telemetry | `/api/articles` | `GET` | `200 OK` | `X-Trace-Id` generated, `X-Upstream-Id: fastapi-service` |
| 10 | Prometheus Metrics Exposition | `/metrics` | `GET` | `200 OK` | Prometheus scrape target active, status counters updated |

---

## 🔧 Engineering Challenges Solved

### 1. Python 3.14 & Modern bcrypt Compatibility
* **Issue**: Legacy `passlib` broke on modern `bcrypt` (>= 4.1.0) on Python 3.14 due to wrap-bug test checks throwing `ValueError: password cannot be longer than 72 bytes`.
* **Resolution**: Replaced `passlib` with native `bcrypt.hashpw` and `bcrypt.checkpw` in `app/services/security.py`, correctly truncating to 72 bytes.

### 2. Modern aiosql Async Generator Unwrapping
* **Issue**: Modern `aiosql` returns an async generator for `SELECT` queries without an operator, causing `TypeError: async_generator object cannot be awaited` in FastAPI repositories.
* **Resolution**: Patched `Queries._make_async_fn` in `app/db/queries/queries.py` to seamlessly collect async generator rows into a list, matching FastAPI Conduit repository signatures.

### 3. Service Registry Stale Snapshot Purging
* **Issue**: Rehydrated mock entries (`srv-a`, `srv-b`) from earlier tests persisted in `proxy_registry_backup.json`, causing Grafana to report them as `DOWN`.
* **Resolution**: Enhanced `src/core/cluster/master.ts` to automatically detect and deregister unconfigured upstreams on startup and config reload, ensuring only active upstreams are monitored.

### 4. Zero-Traffic PromQL NaN Guard in Grafana
* **Issue**: During idle traffic, standard PromQL `100 * sum(rate(5..[1m])) / sum(rate(all[1m]))` evaluated to `NaN` (0 / 0), causing Grafana to display "No data" or stick to prior peak values.
* **Resolution**: Applied guarded PromQL formula `(sum(rate(5..[1m])) / (sum(rate(all[1m])) > 0) * 100) or vector(0)` and added `"noValue": "0%"` to the dashboard.

---

## 🚀 Execution Commands

```bash
# 1. Start FastAPI Backend (Terminal 1)
cd /Users/praveen/Code/fastapi-conduit
.venv/bin/uvicorn --host 127.0.0.1 --port 8000 app.main:app

# 2. Start Ninja Reverse Proxy (Terminal 2)
cd /Users/praveen/Code/Backend/reverse-proxy
node dist/index.js --config /Users/praveen/Code/fastapi-conduit/config.yaml

# 3. Run Automated Verification Suite (Terminal 3)
cd /Users/praveen/Code/Backend/reverse-proxy
node tests/fastapi-gateway-verification.mjs

# 4. View Real-Time Observability
# Swagger UI: http://localhost:8080/docs
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3000 (Last 5 minutes -> 0% error rate, UP)
```
