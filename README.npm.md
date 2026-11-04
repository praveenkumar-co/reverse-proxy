<div align="center">

# 🛡️ Ninja Reverse Proxy

**Enterprise-grade Layer 7 Reverse Proxy, Load Balancer & API Gateway for Node.js & TypeScript.**  
*A lightweight, zero-native-dependency alternative to NGINX and Envoy with built-in resilience, caching, and observability.*

[![npm version](https://img.shields.io/npm/v/ninja-reverse-proxy.svg?color=cb3837&style=flat-square)](https://www.npmjs.com/package/ninja-reverse-proxy)
[![npm downloads](https://img.shields.io/npm/dm/ninja-reverse-proxy.svg?color=blue&style=flat-square)](https://www.npmjs.com/package/ninja-reverse-proxy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/praveenkumar-co/reverse-proxy/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg?style=flat-square)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/praveenkumar-co/reverse-proxy)

[GitHub Repository](https://github.com/praveenkumar-co/reverse-proxy) • [Documentation](https://github.com/praveenkumar-co/reverse-proxy/tree/main/docs) • [Benchmarks](https://github.com/praveenkumar-co/reverse-proxy/tree/main/docs/results/load-tests) • [Issues](https://github.com/praveenkumar-co/reverse-proxy/issues)

</div>

---

## ⚡ Highlights

- 🚦 **Canary Deployments (v1.2+)**: Weighted traffic splitting (e.g. 90/10) with sticky session cookies (`NINJA_CANARY`), header overrides (`x-canary: beta`), and zero-downtime health fallback.
- ⚖️ **12 Load Balancing Algorithms**: Power-of-Two Choices (P2C), Smooth NGINX Weighted Round Robin, Latency EWMA, Consistent Hashing (150 virtual nodes), Least Connections, and IP Hash.
- ⏱️ **5 Rate Limiting Algorithms**: Token Bucket, Sliding Window Log, Sliding Window Counter, Leaky Bucket, and Fixed Window with Memory or Redis Lua backends.
- 🚀 **Two-Tier Hybrid Caching**: In-memory LRU (L1 RAM) + Redis (L2) with `stale-while-revalidate`, `stale-if-error`, and Debezium CDC log invalidation.
- 🛡️ **Fault Tolerance & Resilience**: Classic & Google SRE Adaptive Circuit Breakers, Bulkhead concurrency isolation, and 4 Jitter backoff retry algorithms.
- 📊 **Full Observability**: Native Prometheus exposition (`/metrics`), live health probes (`/__ready`, `/__health`), and 5 auto-provisioned Grafana dashboards.
- 🔌 **L4 WebSocket Tunneling**: Zero-copy TCP piping with session affinity for realtime WebSockets and Socket.IO.

---

## 🚀 Quick Start

### 1. Global Installation (CLI)

```bash
npm install -g ninja-reverse-proxy
```

### 2. Run Instantly with `npx`

```bash
npx ninja-reverse-proxy --config config.yaml
```

---

## 📄 Minimal Configuration (`config.yaml`)

Create a `config.yaml` file in your project directory:

```yaml
server:
  host: "0.0.0.0"
  port: 8080
  workers: 0                    # 0 = auto-detect all available CPU cores
  upstreams:
    - id: "backend-v1"
      url: "http://127.0.0.1:3001"
      weight: 9
      healthPath: "/health"
    - id: "backend-v2-canary"
      url: "http://127.0.0.1:3002"
      weight: 1
      healthPath: "/health"

  paths:
    - path: "/api"
      upstream: ["backend-v1"]
      canary:
        enabled: true
        canaryUpstream: "backend-v2-canary"
        baselineUpstream: "backend-v1"
        weight: 10              # 10% traffic to Canary, 90% to Baseline
        stickyCookieName: "NINJA_CANARY"
        headerKey: "x-canary"   # Force route: curl -H "x-canary: beta"
        headerValue: "beta"

      rateLimit:
        maxRequests: 100
        windowMs: 60000
        algorithm: "token-bucket"

      cache:
        enabled: true
        ttlSeconds: 60

loadBalancing:
  strategy: "power-of-two"      # power-of-two | weighted-round-robin | least-connections | consistent-hashing

resilience:
  circuitBreaker:
    mode: "adaptive"            # Google SRE drop probability breaker
  retry:
    maxAttempts: 3
    backoff: "full-jitter"
```

Start the proxy:
```bash
ninja-reverse-proxy --config config.yaml
```

---

## 💻 Programmatic Usage (Node.js & TypeScript)

You can also embed Ninja Reverse Proxy directly inside your Node.js application:

```typescript
import { createServer, validateConfig } from 'ninja-reverse-proxy';

// validateConfig fills in every schema default (workers, timeouts, resilience, ...), the
// same way a config.yaml file would when loaded via the CLI.
const config = await validateConfig({
  server: {
    port: 8080,
    upstreams: [
      { id: 'srv-1', url: 'http://127.0.0.1:3001', weight: 1 },
      { id: 'srv-2', url: 'http://127.0.0.1:3002', weight: 1 },
    ],
    paths: [
      {
        path: '/api',
        upstream: ['srv-1', 'srv-2'],
      }
    ],
    loadBalancing: {
      strategy: 'round-robin',
    }
  }
});

await createServer({
  port: config.server.port,
  workerCount: config.server.workers || 1,
  config,
});

console.log('🚀 Ninja Reverse Proxy listening on port 8080');
```

---

## 📊 Hyperscale Performance Benchmark

Benchmarked under sustained multi-method eCommerce traffic using k6 across clustered workers:

| Concurrency | Workload Profile | Throughput | Latency (P50) | Latency (P99) | Error Rate |
| :---: | :--- | :---: | :---: | :---: | :---: |
| **100 VUs** | eCommerce Mix | **3,913 req/s** | 21.19 ms | 92.15 ms | **0.00%** |
| **300 VUs** | eCommerce Mix | **5,421 req/s** | 51.35 ms | 123.12 ms | **0.00%** |
| **500 VUs** | Sliding Window Rate Limit | **17,750 req/s** | 20.85 ms | 96.57 ms | **0.00%** |
| **1,000 VUs** | DDoS Saturation Burst | **13,685 req/s** | 61.02 ms | 223.28 ms | **0.00%** |

*Total Benchmark Volume: **627,212 requests processed** with zero socket drops and under 150 MB RSS memory footprint.*

---

## 📈 Monitoring & Telemetry

Exposes standard OpenMetrics on `/metrics` for scraping by Prometheus:
- Latency Histograms: P50, P90, P99 percentiles per route
- Status Codes: Counters for `2xx`, `3xx`, `429`, `502`, and `503`
- Circuit Breaker Gauges: Live state (`CLOSED`, `OPEN`, `HALF_OPEN`)
- Cache Counters: Hit vs. Miss ratios

Pre-configured Grafana dashboards are available in `deploy/monitoring/grafana/dashboards/`.

---

## 📚 Detailed Documentation

For architectural deep-dives, algorithm mathematics, and configuration references, visit the [official GitHub repository](https://github.com/praveenkumar-co/reverse-proxy):

- [12 Load Balancing Algorithms Guide](https://github.com/praveenkumar-co/reverse-proxy/blob/main/docs/03-load-balancing.md)
- [5 Rate Limiting Algorithms Guide](https://github.com/praveenkumar-co/reverse-proxy/blob/main/docs/05-rate-limiting.md)
- [Multi-Tier Caching & Invalidation](https://github.com/praveenkumar-co/reverse-proxy/blob/main/docs/07-caching.md)
- [Circuit Breaker & Google SRE Adaptive Math](https://github.com/praveenkumar-co/reverse-proxy/blob/main/docs/06-circuit-breaker.md)
- [Master-Worker IPC Architecture](https://github.com/praveenkumar-co/reverse-proxy/blob/main/docs/08-master-worker-architecture.md)

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](https://github.com/praveenkumar-co/reverse-proxy/blob/main/LICENSE) for more information.

Copyright © 2026 [Praveen Kumar](https://github.com/praveenkumar-co).
