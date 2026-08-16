# Ninja-Proxy Architecture

Ninja-Proxy is a production-grade, enterprise reverse proxy built on Node.js with cluster-mode multi-process architecture.

## Core Components

- **Balancer** — Pluggable load-balancing strategies with circuit breaker and SRE adaptive throttling
- **Resilience** — Exponential backoff with jitter, retry budgets, bulkhead, and circuit breakers
- **Rate Limiting** — 5 algorithms with Redis distributed storage and memory fallback
- **Cache** — L1 (in-memory LRU) + L2 (Redis) hybrid cache with Debezium CDC invalidation
- **Discovery** — Dynamic service registry with active/passive health probing
- **Observability** — Prometheus metrics, structured logging, and distributed tracing hooks

## Data Flow

```
Client → HTTPS Server → Rate Limiter → Cache Check → Load Balancer
  → Circuit Breaker → Worker → Upstream → Response → Cache Store → Client
```
