# 📖 Reverse Proxy & Load Balancer — Architecture & Interview Guide

---

## Files

| # | File | Topic |
|---|------|-------|
| 00 | [00-index.md](./00-index.md) | Documentation index, system architecture & quick cheat sheet |
| 01 | [01-websocket.md](./01-websocket.md) | WebSocket proxying — HTTP Upgrade, TLSSocket, pipe tunnel |
| 02 | [02-tls-https.md](./02-tls-https.md) | TLS/HTTPS — cert loading, handshake, httpsServer |
| 03 | [03-load-balancing.md](./03-load-balancing.md) | Load balancing — all 12 strategies, WRR deep dive, consistent hashing |
| 04 | [04-health-checks.md](./04-health-checks.md) | Health checks — active/passive probes, state machine |
| 05 | [05-rate-limiting.md](./05-rate-limiting.md) | Rate limiting — 5 algorithms, Redis Lua, multi-dimension |
| 06 | [06-circuit-breaker.md](./06-circuit-breaker.md) | Circuit breaker — classic vs adaptive, bulkhead, retry jitter |
| 07 | [07-caching.md](./07-caching.md) | Caching — L1/L2, stale-while-revalidate, Debezium CDC |
| 08 | [08-master-worker-architecture.md](./08-master-worker-architecture.md) | Master-Worker cluster — IPC, pipeline, auto-restart |
| 09 | [09-service-registry.md](./09-service-registry.md) | Service registry — static/dynamic registration, disk snapshot, LB sync |
| 10 | [10-middleware-pipeline.md](./10-middleware-pipeline.md) | Middleware pipeline — onion model, RequestContext, execution order, next() |
| 11 | [11-observability.md](./11-observability.md) | Observability — Prometheus /metrics, structured logging, multi-worker aggregation, tenant log streamer |
| 12 | [12-https-request-flow.md](./12-https-request-flow.md) | Regular HTTPS request flow — TLS termination, worker dispatch, response streaming (.pipe) |
| 13 | [13-config-zod-validation.md](./13-config-zod-validation.md) | Config & Zod validation — runtime schema validation, type safety, worker propagation |

---

## Quick Cheat Sheet

**"What did you build?"**
> A production-grade Layer 7 reverse proxy and load balancer in TypeScript. It supports 12 load balancing strategies, 5 rate limiting algorithms, circuit breakers, multi-tier caching with Debezium CDC invalidation, WebSocket proxying over TLS, dynamic service registry, onion-model middleware pipeline, Prometheus observability, and a multi-worker cluster architecture.

**"How is it different from just using NGINX?"**
> NGINX is written in C and configured declaratively. Mine is fully programmatic in TypeScript — every component (load balancer, cache, rate limiter, middleware) is a pluggable strategy implementing a common interface. You can swap algorithms at runtime via config or dynamic REST API, extend with custom middleware, and it has type-safe config validation via Zod schemas.

**"What was the hardest bug you fixed?"**
> Node.js IPC cannot transfer TLSSocket objects between processes because TLSSocket is a JS object with in-memory crypto state — not a transferable OS file descriptor. WebSocket connections over HTTPS were crashing silently. Fixed by detecting `socket instanceof tls.TLSSocket` in the upgrade handler and tunneling directly in master instead of routing to a worker.

**"How does the middleware pipeline work?"**
> It's an onion model (`ctx, next`). Every request passes through an ordered chain: CORS → Body Limit → Auth → Rate Limiting → Cache → Circuit Breaker → Bulkhead → Proxy. Calling `next()` invokes the next middleware. Short-circuiting (e.g. cache hit, rate limit 429) stops execution early. Response flows back up through middlewares in reverse order as promises resolve.

**"How do upstreams register and survive restarts?"**
> Upstreams register statically via `proxy.yaml` at boot or dynamically at runtime via REST API (`POST /__registry/register`). The registry persists mutations to a `registry.json` disk snapshot. On proxy restart, it rehydrates automatically and immediately broadcasts updated upstream lists to all worker processes via IPC.

**"How is observability handled across worker processes?"**
> Prometheus metrics are exposed at `/metrics`. Each worker tracks local metrics (counters, EWMA latency percentiles, connections). When `/metrics` is requested on master, master requests snapshots from all workers over IPC (`METRICS_REQUEST`), merges them into a unified exposition format, and responds. Structured JSON logging and per-tenant webhook log streaming are also supported.

**"Walk me through a regular HTTPS request vs a WebSocket request."**
> Both terminate TLS at master's `httpsServer` (port 8443). For regular HTTPS requests, master reads the decrypted HTTP request, sends request metadata via IPC to a worker, which runs the middleware pipeline and streams the backend response via `.pipe()`. For WebSockets (`upgrade` event), because a `TLSSocket` cannot be sent over IPC, master bypasses workers entirely and establishes a direct TCP tunnel to the backend upstream.

**"How do you validate configuration safely?"**
> Using Zod schemas at startup. The YAML is parsed and validated against `ProxyConfigSchema`. Invalid types, typos, or missing fields fail immediately with descriptive errors before any servers start. Validated config is passed down to workers via the `APP_CONFIG` environment variable during `cluster.fork()`.

---

## Architecture at a Glance

```
Browser (HTTPS/WSS)
     │
     ▼
Master Process
  ├── httpsServer (port 8443)   ← TLS termination
  ├── httpServer (port 8080)    ← redirect to HTTPS
  ├── Load Balancer             ← picks upstream
  ├── Service Registry          ← upstream addresses
  ├── Health Manager            ← monitors upstreams
  └── WebSocket (TLSSocket)     ← direct tunnel (no IPC)
     │
     │ IPC (for plain HTTP/WS)
     │
  ├── Worker 1
  │     └── Middleware Pipeline → backend
  └── Worker 2
        └── Middleware Pipeline → backend
     │
     ▼
Backend Services (port 3009, 3001, etc.)
```
