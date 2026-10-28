# Ninja Reverse Proxy & API Gateway

An enterprise-grade, high-throughput reverse proxy and resilience gateway built in TypeScript / Node.js.

## Quick Commands

- **Build**: `npm run build` (TypeScript compilation via `tsc -p .`)
- **Start Proxy**: `npm start` (Runs `dist/index.js --config config.yaml`)
- **Development**: `npm run dev` (Runs with hot-reload via `tsc-watch`)
- **Production Pre-Flight**: `npm run test:preflight` (10/10 production checks)
- **Full Architecture Audit**: `npm run test:audit` (183 component & system tests across 44 modules)
- **Traffic Management & Resilience**: `npm run test:ddia` (11 distributed systems benchmarks)
- **Chaos & Socket Leak Suite**: `node tests/chaos-resilience-suite.mjs` (12/12 adversarial tests)
- **Aggressive Fire Stress Test**: `npm run test:fire` (10,000 req wave, backend drop chaos, memory fence)
- **Deep Architecture & Wiring Audit**: `npm run audit:arch` (Evaluates 125 files, reachability graph, 18 capabilities)
- **Claude Code Audit Directive**: See `AUDIT_DIRECTIVE_FOR_CLAUDE.md` for full instructions to perform an adversarial codebase inspection
- **Master Verification Runner**: `bash scripts/master-test-and-audit.sh` (Runs all suites in sequence)

## Architecture Overview

```
src/
├── balancer/           # Routing strategies (RoundRobin, LeastConnections, ConsistentHash, PowerOfTwo, Canary)
├── cache/              # 2-Tier Caching (L1 In-Memory LRU + L2 Redis, Debezium CDC invalidation, Tag purge)
├── config/             # Zod validation schemas for server, routes, resilience, and rate-limiting
├── core/
│   ├── cluster/        # Multi-core primary (master.ts) & worker processes (worker.ts) with backpressure IPC
│   ├── pipeline/       # Middleware pipeline, HTTP/WebSocket upgrade handling, and connection pooling
│   └── router/         # Longest-prefix route matcher with HTTP method guards & route-level bearer auth
├── observability/      # OpenMetrics Prometheus exporter, HDR duration histograms, W3C traceparent tracer
├── ratelimit/          # TokenBucket, LeakingBucket, SlidingWindow with 50,000-entry bounded LRU stores
└── resilience/         # Bulkhead concurrency isolation, Classic/Adaptive circuit breakers, Jittered retries
```

## Critical Production Invariants

1. **Bidirectional IPC Backpressure**: All IPC between master and worker uses `workerSend()` and `safeProcessSend()` to queue payloads when the pipe buffer is full, preventing silent message drops under floods.
2. **Client Abort Destruction**: Client connection disconnects (`res.on('close')`) immediately dispatch `ABORT_REQUEST` to destroy in-flight upstream `proxyReq` sockets, preventing socket leaks.
3. **Idempotency Protection**: Mutating methods (`POST`, `PUT`, `DELETE`) are strictly barred from auto-retrying on 502/503/504 errors unless an `Idempotency-Key` header is present.
4. **Probe Slot Neutrality**: When a circuit breaker is in `HALF_OPEN`, pre-dispatch rejections (e.g. bulkhead at capacity) call `cancelProbe()` so the single trial slot is not permanently locked in-flight.
5. **Bounded Memory Guards**: All in-memory caches, rate limiters, and trace buffers enforce hard LRU size limits (< 50,000 keys) and periodic unref'd sweeps.
