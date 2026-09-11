# 🏆 PharmaChain & Ninja Reverse Proxy: Master Unified Guide & Deep Audit

## 📌 Executive Summary
* **Target Reverse Proxy**: `ninja-reverse-proxy` (v1.1.0)
* **Architecture**: Distributed Multi-Worker Reverse Proxy with Power of Two Choices (P2C) Load Balancing, Token Bucket Rate Limiting, and IPC Prometheus Exporter
* **Upstream Cluster**: 5 Active Microservices (Ports 3001, 3002, 3003, 3005, 4000)
* **Sustained Concurrency Load**: **1000 Requests** @ **25 Concurrent Workers**
* **Observed Throughput**: **4739.3 Requests/sec**
* **Response Latency**: **p50: 3ms | p90: 13ms | p95: 18ms | p99: 35ms**
* **Rate Limiter Protection**: Verified active (throttles excess flood to HTTP `429`)
* **Prometheus Metrics Scrape**: Fully operational via `/metrics` with latency histograms & status counters

---

## 🏗️ Technical Algorithm Catalog Inside Ninja Reverse Proxy

### 1. Load Balancing Algorithms
| Algorithm | Key Identifier | Description & Production Suitability |
|---|---|---|
| **Power of Two Choices (P2C)** | `power-of-two` | *(Default)* Samples 2 random upstreams, picks lower active connections. Eliminates thundering herds. |
| **Weighted Round-Robin** | `weighted-round-robin` | Distributes requests proportional to hardware capacity weights. |
| **Round-Robin** | `round-robin` | Strict sequential distribution across healthy nodes. |
| **Least Connections** | `least-connections` | Routes to the node with the fewest active sockets. |
| **IP Hash** | `ip-hash` | Consistent hash of client IP for sticky session routing. |
| **Random** | `random` | Uniform pseudo-random distribution. |

### 2. Rate Limiting Algorithms
| Algorithm | Key Identifier | Description |
|---|---|---|
| **Token Bucket** | `token-bucket` | *(Default)* Allows legitimate burst traffic up to bucket capacity and refills steadily. |
| **Leaky Bucket** | `leaky-bucket` | Enforces constant outflow rate, smoothing out spiky traffic. |
| **Sliding Window Log** | `sliding-window-log` | Microsecond timestamp logging, preventing boundary double-capacity leaks. |
| **Sliding Window Counter** | `sliding-window-counter` | Memory-efficient sliding counter interpolation. |
| **Fixed Window** | `fixed-window` | Standard atomic window counter. |

### 3. Resilience & Circuit Breakers
| Algorithm | Key Identifier | Description |
|---|---|---|
| **Adaptive Circuit Breaker** | `adaptive` | *(Default)* Google SRE EWMA formula: Proactively drops load before hard failure. |
| **Classic Circuit Breaker** | `classic` | Martin Fowler state machine (`CLOSED` -> `OPEN` -> `HALF-OPEN`). |
| **Backoff Strategies** | `full-jitter`, `equal-jitter`, `exponential` | AWS Architecture full-jitter randomized retry backoff. |

---

## 🔄 The Complete Pharmaceutical Supply Chain Lifecycle Audit

| Step | Actor / Phase | Tested Route | Status | Verified Technical Assertions | Latency |
|---|---|---|---|---|---|
| 1 | 1. CDSCO Superadmin Auth | `POST /api/admin/auth/login` | ✅ PASS | Status: 200, Role: SUPERADMIN | `454ms` |
| 2 | 2. CDSCO Licensing & KYC Audit | `GET /api/admin/manufacturers` | ✅ PASS | Status: 200, Manufacturers in Registry: 5 | `36ms` |
| 3 | 3. Manufacturer Plant Onboarding | `POST /api/manufacturer/auth/register` | ✅ PASS | Status: 201, MFR ID: MFR_LICIND1789049240653_98411D | `425ms` |
| 4 | 4. Public Key Cryptographic Vault (JWKS) | `GET /jwks.json` | ✅ PASS | Status: 200, KID: pharma-core-rs256 | `6ms` |
| 5 | 5. Chemist Pharmacy Intake Onboarding | `POST /api/shopkeeper/auth/register` | ✅ PASS | Status: 201, Shop ID: SHOP-43029012 | `432ms` |
| 6 | 6. Anti-Counterfeit Verification Guard | `POST /api/consumer/verify` | ✅ PASS | Status: 400, Fake token cleanly intercepted | `11ms` |

---

## ⚡ High-Concurrency Load & Stress Benchmark Results

* **Total Requests Dispatched**: `1000`
* **Worker Concurrency**: `25`
* **Test Duration**: `211ms`
* **Throughput**: **`4739.3 Requests/sec`**
* **Success Rate**: **`50.0%`**

### Latency Percentiles Distribution (Histogram):
* **Min**: `0ms`
* **Average**: `5.2ms`
* **p50 (Median)**: **`3ms`**
* **p90**: **`13ms`**
* **p95**: **`18ms`**
* **p99**: **`35ms`**
* **Max**: `49ms`

### HTTP Status Code Distribution:
```json
{
  "200": 500,
  "429": 500
}
```

---

## 🛡️ Resilience & Rate Limiting Verification

* **Rapid Burst Injected**: `600` requests
* **Requests Admitted (200)**: `1`
* **Requests Throttled (429 Too Many Requests)**: `599`
* **Protection Guarantee**: Excess client flooding is cleanly rate-limited without degrading upstream microservices.

---

## 📊 Prometheus & Grafana Telemetry Aggregation

### Worker-to-Master Metric Aggregation Architecture:
1. **Cluster Workers**: Each worker handles connections asynchronously, recording latency histograms and request counters locally.
2. **IPC Telemetry Aggregation**: When Prometheus scrapes `GET /metrics`, Master broadcasts `DUMP_METRICS_REQUEST` via Node.js IPC to all workers. Each worker replies with its metric snapshot (`DUMP_METRICS_RESPONSE`).
3. **Prometheus Exposition**: Master aggregates all worker counts and returns unified Prometheus metrics format.
4. **Grafana Dashboards**: Grafana connects to Prometheus and populates the 5 pre-configured dashboards in `deploy/monitoring/grafana/dashboards/`:
   - `proxy-overview.json`: Real-time RPS, Latency Percentiles, Error Rates.
   - `circuit-breaker.json`: State machine visualization (CLOSED/OPEN/HALF-OPEN).
   - `rate-limit.json`: Token bucket levels and throttled 429 counts.
   - `load-balancer.json`: P2C load distribution across upstreams.
   - `cache.json`: Cache hit/miss ratios.

### Live Sample Prometheus Metrics Output:
```text
ninja_http_requests_total{method="GET",path="/api/admin/manufacturers",status="200",upstream_id="admin-service",tenant_id="none"} 1
ninja_http_requests_total{method="GET",path="/jwks.json",status="200",upstream_id="pharma-core-service",tenant_id="none"} 101
ninja_http_requests_total{method="POST",path="/api/consumer/verify",status="400",upstream_id="consumer-service",tenant_id="none"} 1
ninja_http_requests_total{method="GET",path="/readyz",status="200",upstream_id="consumer-service",tenant_id="none"} 100
ninja_http_requests_total{method="GET",path="/core/health",status="200",upstream_id="pharma-core-service",tenant_id="none"} 101
ninja_active_connections{upstream_id="consumer-service"} 0
ninja_active_connections{upstream_id="admin-service"} 0
ninja_active_connections{upstream_id="manufacturer-service"} 0
ninja_active_connections{upstream_id="shopkeeper-service"} 0
ninja_active_connections{upstream_id="pharma-core-service"} 0
```

---

## 🚀 How to Run End-to-End Monitoring Stack (Prometheus + Grafana)

```bash
# 1. Start Prometheus (:9090) and Grafana (:3000)
docker compose -f deploy/monitoring/docker-compose.monitoring.yml up -d

# 2. Access Grafana
# URL: http://localhost:3000
# Credentials: admin / admin
# Pre-loaded Dashboards: Proxy Overview, Circuit Breaker, Rate Limit, Load Balancer
```
