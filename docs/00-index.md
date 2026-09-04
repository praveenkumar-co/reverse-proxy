
---

## Files

| # | File | Topic |
|---|------|-------|
| 01 | [01-websocket.md](./01-websocket.md) | WebSocket proxying — HTTP Upgrade, TLSSocket, pipe tunnel |
| 02 | [02-tls-https.md](./02-tls-https.md) | TLS/HTTPS — cert loading, handshake, httpsServer |
| 03 | [03-load-balancing.md](./03-load-balancing.md) | Load balancing — all 12 strategies, WRR deep dive, consistent hashing |
| 04 | [04-health-checks.md](./04-health-checks.md) | Health checks — active/passive probes, state machine |
| 05 | [05-rate-limiting.md](./05-rate-limiting.md) | Rate limiting — 5 algorithms, Redis Lua, multi-dimension |
| 06 | [06-circuit-breaker.md](./06-circuit-breaker.md) | Circuit breaker — classic vs adaptive, bulkhead, retry jitter |
| 07 | [07-caching.md](./07-caching.md) | Caching — L1/L2, stale-while-revalidate, Debezium CDC |
| 08 | [08-master-worker-architecture.md](./08-master-worker-architecture.md) | Master-Worker cluster — IPC, pipeline, auto-restart |

---

**"What did you build?"**
> A production-grade Layer 7 reverse proxy and load balancer in TypeScript. It supports 12 load balancing strategies, 5 rate limiting algorithms, circuit breakers, multi-tier caching with Debezium CDC invalidation, WebSocket proxying over TLS, and a master-worker cluster architecture.

**"How is it different from just using NGINX?"**
> NGINX is written in C and configured declaratively. Mine is fully programmatic in TypeScript — every component (load balancer, cache, rate limiter) is a pluggable strategy implementing a common interface. You can swap algorithms at runtime via config, extend with custom middleware, and it has type-safe config validation via Zod schemas.

**"What was the hardest bug you fixed?"**
> Node.js IPC cannot transfer TLSSocket objects between processes because TLSSocket is a JS object with in-memory crypto state — not a transferable OS file descriptor. WebSocket connections over HTTPS were crashing silently. Fixed by detecting `socket instanceof tls.TLSSocket` in the upgrade handler and tunneling directly in master instead of routing to a worker.

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
