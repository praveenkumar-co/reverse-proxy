# 🕵️ ARCHITECTURAL AUDIT & CODEBASE INTEGRITY DIRECTIVE FOR CLAUDE CODE
> **Target:** `ninja-reverse-proxy` (v1.2.2)  
> **Auditor:** Claude Code (CLI / Agentic Assistant)  
> **Objective:** Perform an adversarial, in-depth architectural inspection to determine if this codebase is an **enterprise-ready production reverse proxy** or a **toy / "teddy" project**. Pinpoint dead code, internal wiring gaps, over-engineered features, and hidden failure edges.

---

## ⚡ QUICK START FOR CLAUDE CODE

Run the automated dependency graph & subsystem connectivity audit:
```bash
npm run audit:arch
```
*(Or get machine-readable JSON: `node scripts/deep-architecture-audit.mjs --json`)*

To run all enterprise verification and benchmark suites:
```bash
npm run build
node tests/production-preflight-check.mjs
node tests/full-system-audit.mjs
node tests/ddia-benchmarks-test.mjs
node tests/chaos-resilience-suite.mjs
node tests/executive-showcase-suite.mjs
npm run test:fire
```

---

## 🎯 AUDIT MANDATE: 6 CRITICAL INVESTIGATION DIMENSIONS

Please inspect the codebase against the following 6 dimensions and produce an uncompromising, executive-level technical assessment.

---

### DIMENSION 1: Core Datapath & Cluster IPC Integrity
**Files to inspect:** `src/core/cluster/master.ts`, `src/core/cluster/worker.ts`, `src/core/router/route-matcher.ts`

**Questions to answer:**
1. **Request Lifecycle Flow:** Trace an incoming client HTTP request from `master.ts` -> route matching -> worker selection -> IPC message -> `worker.ts` -> upstream connection -> streaming chunk pipe -> client response.
   - Is it streaming end-to-end, or does it buffer entire payloads in memory?
   - Does downstream disconnect (`res.on('close')`) immediately kill the upstream socket (`proxyReq.destroy()`) to prevent ghost loads?
2. **IPC Backpressure:** Under heavy concurrency (e.g. 5,000–10,000 req/s), does `master.ts` -> `worker.send()` saturate the Node.js IPC channel?
   - How does `workerSend()` handle `channel.write()` returning `false`?
   - Does it pause reading from the client socket (`req.socket.pause()`) until `'drain'` fires?
3. **Master Process Lightweightness:** Does `master.ts` perform CPU-heavy parsing, or does it strictly route and delegate?

---

### DIMENSION 2: Complete 125-File Subsystem & Dead Code Inventory
The dependency analyzer scanned all 125 TypeScript source files across 10 functional subsystems.

**Examine all 10 Subsystems:**
1. **Balancer (19 files):** 12 strategies registered in `balancer.factory.ts`. Are all 12 truly functional with unit benchmarks?
2. **Cache (15 files):** Hybrid L1/L2, SWR, Stale-if-error, Tag/Pattern invalidators, Debezium CDC.
3. **Config (13 files):** Zod schemas in `schemas/*` vs. 3 legacy unreferenced schemas (`config-schema.ts`, `config.ts`, `server-schema.ts`).
4. **Core Cluster (13 files):** `master.ts`, `worker.ts`, `ipc.protocol.ts`, `route.matcher.ts`, `connection.pool.ts`, `websocket.handler.ts` vs. 3 legacy single-process prototypes (`http.handler.ts`, `upstream.client.ts`, `router.ts`).
5. **Discovery (7 files):** `dynamic.registry.ts`, `health.manager.ts`, `active.probe.ts`, `passive.probe.ts` vs. isolated `target-node.ts`.
6. **Middleware (9 files):** `cors`, `auth`, `body-limit`, `tracing` vs. 5 unused standalone middlewares (`cache`, `circuit`, `fencing`, `logging`, `rate-limit`).
7. **Observability (9 files):** Prometheus exporter, HDR histograms, tenant log streamer, structured logger, readiness probe, W3C trace context.
8. **Rate Limiting (14 files):** 5 algorithms (`token-bucket`, `leaking-bucket`, `fixed-window`, `sliding-window-log`, `sliding-window-counter`), SoftLimitPolicy, BoundedStore vs. 3 isolated stores in `storage/*`.
9. **Resilience (18 files):** Bulkhead, Classic & Adaptive circuit breakers, 4 jitter backoffs, Idempotency safe-retry, Retry budget vs. 3 dead state classes (`closed.state.ts`, `open.state.ts`, `half-open.state.ts`) and `idempotent.policy.ts`.
10. **Types (7 files):** Upstream, balancer, config, http, resilience type contracts.

**The 14 Dead Files (Zero Runtime & Zero Test Importers):**
- `src/config/config-schema.ts`
- `src/config/config.ts`
- `src/config/server-schema.ts`
- `src/core/proxy/http.handler.ts`
- `src/core/proxy/upstream.client.ts`
- `src/core/router/router.ts`
- `src/middleware/cache.middleware.ts`
- `src/middleware/circuit.middleware.ts`
- `src/middleware/fencing.middleware.ts`
- `src/middleware/logging.middleware.ts`
- `src/middleware/rate-limit.middleware.ts`
- `src/resilience/circuit-breaker/states/closed.state.ts`
- `src/resilience/circuit-breaker/states/half-open.state.ts`
- `src/resilience/circuit-breaker/states/open.state.ts`

**Deliverable:**
- Confirm if any of these 14 files contain unmigrated logic that should be preserved, or if they can safely be pruned to eliminate tech debt.
- Address the 5 isolated modules (`src/ratelimit/storage/*` and `src/resilience/retry/retry-handler.ts`).

---

### DIMENSION 3: Over-Engineered / "Fluff" Features vs. Core Value
Reverse proxies should be lean, ultra-fast, and predictable. Some features in this repo may be exotic or inappropriate for an edge gateway:

1. **Debezium CDC Stream Invalidation (`src/cache/invalidation/debezium.invalidator.ts`):**
   - *Critique:* Does a reverse proxy belong in a Kafka/Debezium database change-data-capture stream, or is this an architectural antipattern that belongs in a cache management service?
   - *Alternative:* Is HTTP Tag Purge (`POST /__cache/purge/tag`) sufficient?
2. **Exotic Load Balancing Strategies:**
   - Of the 12 strategies registered in `src/balancer/factory/balancer.factory.ts`, are strategies like `AdaptiveWRR` and `ResourceBased` practical without dedicated host telemetry sidecars?
   - Are standard algorithms (`round-robin`, `least-connections`, `consistent-hash`, `ip-hash`, `weighted-round-robin`) cleanly isolated?
3. **Dual L1/L2 Cache Architecture:**
   - How does the system behave when Redis goes down? Does it degrade gracefully to in-memory LRU without blocking event-loop workers?

---

### DIMENSION 4: Edge Cases & Extreme Failure Modes
Audit the codebase for real-world production failure modes:

1. **The Thundering Herd / Half-Open Race:**
   - In `ClassicCircuitBreaker`, when transitioning from `OPEN` to `HALF_OPEN`, does it allow only a single trial probe through, or can concurrent incoming requests flood the recovering upstream?
   - Verify `cancelProbe()` implementation in `src/resilience/circuit-breaker/classic.circuit-breaker.ts`.
2. **Financial / Payment Safety (Idempotency Guard):**
   - If an upstream returns `503` on a `POST /checkout` request, will the proxy blindly retry it and double-charge the user?
   - Inspect `isMethodRetrySafe()` and `Idempotency-Key` header enforcement in `master.ts`.
3. **Socket Starvation & Client Drop (Slowloris / Mid-Flight Abort):**
   - If a client opens a connection and abandons it halfway through an upstream transfer, does the reverse proxy leak sockets or memory?
   - Verify `res.on('close')` socket cleanup.
4. **OS Kernel Limits (macOS vs. Linux):**
   - On macOS, `kern.ipc.somaxconn: 128` clamps listen socket backlogs. How does connection pooling (`http.Agent({ keepAlive: true, maxSockets: 256 })`) protect against `ECONNRESET` during high RPS?

---

### DIMENSION 5: Observability & Production Readiness
Check metrics, logs, and distributed tracing:
1. **Metrics:** Is Prometheus `/metrics` exposition format clean, monotonic, and compatible with standard Prometheus scrapers?
2. **Histograms:** Are response durations recorded in HDR histograms with microsecond/millisecond precision?
3. **Tracing:** Is W3C `traceparent` forwarded across hops and decorated with a fresh child `span-id`?
4. **Graceful Shutdown:** Does the server stop accepting new connections (`server.close()`), wait for in-flight requests to drain (`activeRequests === 0`), and exit cleanly within a deadline?

---

### DIMENSION 6: The Ultimate Verdict — "Teddy Project" or Enterprise Gateway?
Provide a definitive, blunt evaluation:
1. **Classification:**
   - [ ] Toy / Student / Teddy Project
   - [ ] Promising Prototype
   - [ ] Production-Grade Enterprise Gateway
2. **Top 3 Architectural Strengths:** (What makes it stand out from standard naive reverse proxies?)
3. **Top 3 Tech Debt / Cleanup Tasks:** (What needs to be deleted, refactored, or unified before deploying to Kubernetes/ECS?)

---

## 🛠️ HOW TO PRESENT YOUR REPORT TO THE USER
When Claude Code completes the audit, structure the final findings as:
1. **Executive Summary & Verdict Score (0–100%)**
2. **Dead Code & Cleanup Roster** (Exact file paths to delete or keep)
3. **Feature Utility Verdict** (Essential vs. Fluff)
4. **Edge Case & Resilience Analysis**
5. **Production Readiness Checklist**
