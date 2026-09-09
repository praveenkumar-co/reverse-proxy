# 🚀 Deployment, Operations & Monitoring Setup

## Overview
Ninja Reverse Proxy can be deployed as a standalone native Node.js process, a multi-container Docker deployment, or within a Kubernetes cluster.

---

## 1. Local / Bare-Metal Deployment

### Prerequisites
* Node.js v18+ (tested on Node.js v20 LTS)
* OpenSSL (for local TLS certificate generation)
* Redis (optional, required if using `cache.storage: redis` or `ratelimit.storage: redis`)

### Step 1: Install Dependencies & Build
```bash
cd /Users/praveen/Code/Backend/reverse-proxy
pnpm install
npm run build
```

### Step 2: Generate TLS Certificates
For local development, generate a self-signed wildcard certificate:
```bash
npm run generate-certs
# Generates ./cert.pem and ./key.pem
```

### Step 3: Configure `proxy.yaml`
```yaml
server:
  host: "0.0.0.0"
  port: 8080
  workers: 2
  trustProxy: true

tls:
  enabled: true
  cert: "./cert.pem"
  key: "./key.pem"
  redirectHttp: true
  httpsPort: 8443

upstreams:
  - id: chess-backend-1
    url: "http://127.0.0.1:3009"
    healthPath: "/"
    weight: 1
  - id: chess-backend-2
    url: "http://127.0.0.1:3010"
    healthPath: "/"
    weight: 3

routes:
  - path: "/"
    upstreams: ["chess-backend-1", "chess-backend-2"]
    sticky: true
```

### Step 4: Start Proxy
```bash
# Production mode
npm start

# Development mode with hot-reload
npm run dev
```

---

## 2. Docker Compose Monitoring Stack

The proxy includes a pre-configured monitoring stack with Prometheus and Grafana:

```bash
cd deploy/monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

### Services Started

| Service | Port | Description |
|---|---|---|
| **Prometheus** | `http://localhost:9090` | Scrapes proxy metrics from `https://host.docker.internal:8443/metrics` every 5s. |
| **Grafana** | `http://localhost:3000` | Pre-provisioned dashboards (User: `admin`, Pass: `admin`). |

### Pre-loaded Dashboards
* `proxy-overview.json`: Total requests/sec, P95 latency, active connections, error rate.
* `load-balancer.json`: Per-upstream traffic distribution, weight ratios, healthy vs down nodes.
* `circuit-breaker.json`: Circuit breaker state transitions (CLOSED / OPEN / HALF-OPEN).
* `cache.json`: L1 and L2 hit/miss ratios, eviction counts.
* `rate-limit.json`: Throttled requests (HTTP 429), soft-limit warnings.

---

## 3. Production Hardening Checklist

1. **Process Limits (`ulimit -n`)**: Ensure the OS file descriptor limit is set to at least `65535` (`ulimit -n 65535`) to allow high concurrent socket handling.
2. **Reverse Proxy Edge / Cloudflare**: Set `server.trustProxy: true` so client IP is accurately extracted from `X-Forwarded-For` or `CF-Connecting-IP`.
3. **Graceful Shutdown**: On `SIGTERM` or `SIGINT`, the master stops accepting new connections, waits up to 10 seconds for in-flight requests to complete, and terminates cleanly.
