Reverse Proxy Remediation Plan
28 Oct 2026 · @Praveen
Summary
Of 125 source files at commit eedd8ff, 29 should be deleted, 18 need code changes, 6 should become the public library API, 5 stay as opt-in tenant features, and 67 stay as they are. Every delete below was tested: the build and all suites pass after removal (exceptions noted).
Action
Files
Meaning
DELETE-A
23
No importer anywhere. Removed in a scratch copy: build, 183/183 audit, 115/115 unit tests still pass.
DELETE-B
6
Used only by test cases that test code the proxy never runs. Delete the file and those test cases together.
FIX-P0
3
Datapath defects: binary corruption, full buffering, duplicated POSTs. Blocks production.
FIX-P1
10
Correctness or security defect for a multi-user platform.
OPTIMIZE-P2
5
Works, but wasteful or ineffective.
WIRE-API
6
Barrel or interface with no importer. Keep it, and export it from a new library entry point.
KEEP-OPTIONAL
5
Niche feature some tenants need. Keep it off by default, gated by config, with the listed precondition met.
KEEP
67
No defect found in this audit.
The cleanup script handles DELETE-A automatically and DELETE-B behind a guard. Everything else is manual work, described file by file in Per-file actions.
Phase order
Prune first because it is free and verified. Then write failing regression tests, then fix the datapath. Do not start a phase until the previous gate passes.
1. Prune (DELETE-A). Run scripts/cleanup.sh --phase a.
    ◦ Gate: npm run build, npm test and npm run test:audit all pass. npm run audit:arch reports 0 dead files.
2. Add regression tests that fail today. Port the audit probes into tests/datapath-regression.mjs: binary SHA-256 match, SSE time-to-first-byte under 100 ms, zero duplicate POST deliveries under 1,500 concurrent 64 KB requests, a 20 MB response returns 200, and 3 client aborts do not open the breaker.
    ◦ Gate: the file runs and shows exactly those 5 failures.
3. FIX-P0: rebuild the datapath in master.ts, worker.ts and ipc.protocol.ts.
    ◦ Gate: all 5 regression tests pass, and test:fire Phase 1 does not regress below 2,000 RPS.
4. FIX-P1: multi-tenant safety. Client IP trust, CORS, Redis KEYS, CDC, abort accounting, the tenant log streamer, the library entry point.
    ◦ Gate: a spoofed X-Forwarded-For no longer changes the rate-limit key, and a reflected origin with credentials is refused.
5. DELETE-B and test integrity. Run scripts/cleanup.sh --phase b after removing the listed test cases. Move or delete test-only gateway classes. Make harnesses exit non-zero on fatal errors.
    ◦ Gate: no tests/*.mjs file defines a class that is absent from src, and test:fire exits 1 when any phase crashes.
6. OPTIMIZE-P2. AdaptiveWRR, rate limiter internals, logger, connection pool, WebSocket idle timeout.
    ◦ Gate: suites green, and AdaptiveWRR gives a 20 ms backend a larger share than a 1,000 ms one at default weights.
Per-file actions
All 125 files under src/, grouped by subsystem. Paths are relative to src/. KEEP means no defect was found in this audit; it is not a line-by-line review guarantee.
Balancer (19 files)
File
Lines
Action
Change
balancer/contracts/balancer.interface.ts
13
KEEP

balancer/contracts/context.types.ts
7
DELETE-A
No importer.
balancer/contracts/strategy.interface.ts
11
KEEP

balancer/core/load-balancer.ts
280
FIX-P1
requests and failures on each upstream state are initialised to 0 and never updated, so strategies that read them get zeros. Track them as decayed counters. Add recordAbort() that releases the connection and probe slot without counting a failure.
balancer/core/strategy-registry.ts
12
KEEP

balancer/factory/balancer.factory.ts
55
KEEP

balancer/index.ts
6
KEEP
Re-export from the new lib.ts.
balancer/strategies/adaptive-wrr.strategy.ts
35
OPTIMIZE-P2
round() with a floor of 1 makes every backend weight 1 at default config, so it is uniform random. Use float weights. Read the fixed counters from load-balancer. Otherwise point users at power-of-two.
balancer/strategies/consistent-hashing.strategy.ts
51
KEEP-OPTIONAL
For tenants that need cache affinity. Add a key-distribution test across 3 to 10 nodes.
balancer/strategies/ip-hash.strategy.ts
28
KEEP-OPTIONAL
Only correct after the client-IP trust fix in core/pipeline/context.ts.
balancer/strategies/least-connections.strategy.ts
12
KEEP

balancer/strategies/least-response-time.strategy.ts
12
KEEP

balancer/strategies/power-of-two.strategy.ts
18
KEEP
Recommended latency-aware default.
balancer/strategies/random.strategy.ts
10
KEEP

balancer/strategies/resource-based.strategy.ts
26
KEEP-OPTIONAL
Needs backends to report cpu and memory metadata to the registry. Add a staleness TTL so old reports are ignored.
balancer/strategies/round-robin.strategy.ts
14
KEEP

balancer/strategies/sticky-sessions.strategy.ts
24
KEEP-OPTIONAL
For stateful tenant apps. The cookie exposes the upstream id; sign it if ids are sensitive.
balancer/strategies/weighted-least-connections.strategy.ts
14
KEEP

balancer/strategies/weighted-round-robin.strategy.ts
31
KEEP

Cache (15 files)
File
Lines
Action
Change
cache/cache-manager.ts
282
FIX-P1
CDC uses Redis pub/sub, which loses events during reconnects. Switch to a Redis Streams consumer group or drop CDC. With Redis down, startup stalled about 11 s; start in memory-only mode and attach Redis when it connects.
cache/contracts/cache-config.interface.ts
34
KEEP

cache/contracts/cache.interface.ts
8
KEEP

cache/contracts/invalidator.interface.ts
6
KEEP

cache/index.ts
3
WIRE-API
No importer. Export from lib.ts.
cache/invalidation/debezium.invalidator.ts
70
KEEP-OPTIONAL
Remove the *<id>* fallback, which purges every key containing the id. Require explicit table mappings. Keep it off by default.
cache/invalidation/pattern.invalidator.ts
10
FIX-P1
Runs on Redis KEYS. Reject patterns with no literal prefix so one tenant cannot purge everyone's cache.
cache/invalidation/tag.invalidator.ts
16
KEEP
Preferred invalidation primitive.
cache/policies/cache-control.parser.ts
20
KEEP

cache/policies/key-builder.ts
27
KEEP
Add the tenant id to every key prefix.
cache/policies/stale-if-error.ts
7
KEEP

cache/policies/stale-while-revalidate.ts
13
KEEP

cache/stores/hybrid.cache.ts
44
KEEP

cache/stores/in-memory-lru.ts
36
KEEP

cache/stores/redis.cache.ts
40
FIX-P1
Line 25 calls KEYS, which is O(N) and blocks Redis for every client. Replace with scanIterator({ MATCH, COUNT: 500 }) and batched UNLINK.
Config (13 files)
File
Lines
Action
Change
config/config-schema.ts
3
DELETE-A
Dead shim.
config/config.loader.ts
226
KEEP

config/config.ts
2
DELETE-A
Dead re-export.
config/index.ts
10
KEEP

config/schemas/admin.schema.ts
17
KEEP

config/schemas/balancer.schema.ts
55
KEEP

config/schemas/cache.schema.ts
64
KEEP

config/schemas/discovery.schema.ts
31
KEEP

config/schemas/observability.schema.ts
60
KEEP

config/schemas/ratelimit.schema.ts
49
KEEP

config/schemas/resilience.schema.ts
105
KEEP

config/schemas/server.schema.ts
170
FIX-P1
Change the trustProxy default to false. When it is true, require a non-empty trustedProxies list.
config/server-schema.ts
2
DELETE-A
Dead re-export of the IPC protocol.
Core (13 files)
File
Lines
Action
Change
core/admin/admin.handler.ts
261
FIX-P1
/__registry/register accepts any URL. Validate scheme and host against an allowlist, and reject link-local and metadata addresses such as 169.254.169.254, so a tenant cannot make the proxy call internal services.
core/cluster/ipc.protocol.ts
25
FIX-P0
Bodies travel as JSON strings. After the rewrite, IPC carries control messages only (config reload, drain, metrics), never payloads.
core/cluster/master.ts
1,848
FIX-P0
Stop accepting client traffic in the master; let workers listen through cluster's shared port. Delete workerSend's resend loop: send() === false means already queued. Do not call lb.recordFailure() on client abort (line 1650); call recordAbort(). Split the file: routing, dispatch, admin and lifecycle.
core/cluster/worker.ts
480
FIX-P0
Replace buffering with stream.pipeline(req, proxyReq) and pipeline(upstreamRes, res). Remove toString("utf8") on bodies (line 400), which corrupts binary. Pass Content-Encoding through untouched instead of stripping it (line 377). Gzip only when the upstream response is uncompressed. Delete the same resend loop in safeProcessSend.
core/pipeline/context.ts
57
FIX-P1
trustProxy ?? true (line 31) lets any client set X-Forwarded-For and pick its own IP, which bypasses per-IP rate limits. Trust the header only when the socket peer is in trustedProxies, and read the rightmost untrusted hop, not the first.
core/pipeline/middleware.pipeline.ts
23
KEEP

core/proxy/connection.pool.ts
18
OPTIMIZE-P2
Add timeout, maxFreeSockets and scheduling: "lifo". Make maxSockets configurable per upstream.
core/proxy/http.handler.ts
62
DELETE-A
Superseded single-process handler.
core/proxy/upstream.client.ts
15
DELETE-A
Superseded.
core/proxy/websocket.handler.ts
95
OPTIMIZE-P2
Sockets are piped with no idle timeout. Add an idle timeout and a per-route connection cap.
core/router/route.matcher.ts
23
KEEP

core/router/route.types.ts
31
KEEP

core/router/router.ts
16
DELETE-A
Superseded by route.matcher.
Discovery (7 files)
File
Lines
Action
Change
discovery/contracts/registry.interface.ts
14
WIRE-API
Make DynamicRegistry implement IRegistry so other registries (Consul, Kubernetes) can plug in.
discovery/health/active.probe.ts
54
KEEP

discovery/health/health.manager.ts
130
KEEP

discovery/health/passive.probe.ts
16
KEEP

discovery/index.ts
7
WIRE-API
Export from lib.ts.
discovery/registry/dynamic.registry.ts
158
KEEP

discovery/target-node.ts
15
DELETE-A
Only importer is the unused barrel.
Entry point (1 file)
File
Lines
Action
Change
index.ts
129
FIX-P1
README.npm.md documents import { createServer } from 'ninja-reverse-proxy', but this file is the CLI and exports nothing, so importing it starts the CLI. Add src/lib.ts exporting createServer and the barrels. In package.json, set exports to { ".": "./dist/lib.js" } and keep bin on dist/index.js.
Middleware (9 files)
File
Lines
Action
Change
middleware/auth.middleware.ts
17
KEEP
For multiple tenants, map each token to a tenant id instead of one shared set.
middleware/body-limit.middleware.ts
14
KEEP
Header check only. Streaming enforcement belongs in the worker after the P0 rewrite.
middleware/cache.middleware.ts
19
DELETE-A
Dead.
middleware/circuit.middleware.ts
13
DELETE-A
Dead.
middleware/cors.middleware.ts
21
FIX-P1
With the default ['*'], it reflects any Origin and sends Allow-Credentials: true, so any website can make credentialed reads. Never send credentials with a wildcard. Require an explicit origin list per route when credentials are on.
middleware/fencing.middleware.ts
109
DELETE-A
Dead. The DDIA chapter 8 suite tests its own copy. If a tenant needs fencing tokens, restore it from git, wire it to a per-route config key, and test the real module.
middleware/logging.middleware.ts
11
DELETE-A
Dead.
middleware/rate-limit.middleware.ts
29
DELETE-A
Dead; rate limiting runs inline in master.
middleware/tracing.middleware.ts
43
KEEP

Observability (9 files)
File
Lines
Action
Change
observability/health/readiness.ts
29
KEEP

observability/index.ts
17
WIRE-API
Export from lib.ts.
observability/logger/logger.ts
131
OPTIMIZE-P2
fs.appendFile per line opens and closes the file on every log write. Use one fs.createWriteStream and respect its backpressure.
observability/logger/tenant-log.streamer.ts
99
FIX-P1
Tenants are flushed one after another with no fetch timeout, so one slow webhook delays every tenant's logs. Flush in parallel with AbortSignal.timeout(5000) and one bounded retry.
observability/metrics/histogram.registry.ts
109
KEEP

observability/metrics/prometheus.exporter.ts
137
KEEP

observability/metrics/system.metrics.ts
30
KEEP

observability/tracing/tracer.ts
52
KEEP

observability/tracing/w3c-trace-context.ts
40
KEEP

Rate limiting (14 files)
File
Lines
Action
Change
ratelimit/algorithms/fixed-window.ts
36
KEEP

ratelimit/algorithms/leaking-bucket.ts
42
KEEP

ratelimit/algorithms/sliding-window-counter.ts
53
KEEP

ratelimit/algorithms/sliding-window-log.ts
36
KEEP

ratelimit/algorithms/token-bucket.ts
43
KEEP

ratelimit/bounded-store.ts
69
KEEP
The store actually in use.
ratelimit/contracts/limiter.interface.ts
7
DELETE-A
Only importer is the unused barrel.
ratelimit/contracts/storage.interface.ts
6
DELETE-B
Used only by the three dead stores.
ratelimit/index.ts
14
WIRE-API
Remove the store exports, then export from lib.ts.
ratelimit/policies/soft-limit.policy.ts
12
KEEP

ratelimit/rate-limiter.ts
476
OPTIMIZE-P2
Lines 309 to 327 read each algorithm's private ["store"]. Add a public getCount(key) to each algorithm. Accept a key function so tenants can limit by API key or tenant id, not only by IP.
ratelimit/storage/hybrid.store.ts
54
DELETE-B
Test-only.
ratelimit/storage/memory.store.ts
29
DELETE-B
Test-only.
ratelimit/storage/redis.store.ts
17
DELETE-A
No importer. Its separate INCR and PEXPIRE are non-atomic; the inline Lua in rate-limiter is the correct version.
Resilience (18 files)
File
Lines
Action
Change
resilience/bulkhead/bulkhead.ts
37
KEEP
Consider one bulkhead per tenant so one tenant cannot fill every slot.
resilience/circuit-breaker/adaptive.circuit-breaker.ts
38
KEEP

resilience/circuit-breaker/circuit-breaker.manager.ts
29
KEEP

resilience/circuit-breaker/classic.circuit-breaker.ts
66
KEEP

resilience/circuit-breaker/contracts/circuit-breaker.interface.ts
14
KEEP

resilience/circuit-breaker/states/closed.state.ts
7
DELETE-A
The breaker keeps state inline.
resilience/circuit-breaker/states/half-open.state.ts
7
DELETE-A
Same.
resilience/circuit-breaker/states/open.state.ts
7
DELETE-A
Same.
resilience/index.ts
13
WIRE-API
Remove the retry-handler export, then export from lib.ts.
resilience/retry/backoff/decorrelated-jitter.backoff.ts
12
KEEP

resilience/retry/backoff/equal-jitter.backoff.ts
10
KEEP

resilience/retry/backoff/exponential.backoff.ts
8
KEEP

resilience/retry/backoff/full-jitter.backoff.ts
9
KEEP

resilience/retry/contracts/retry.interface.ts
5
DELETE-B
Used only by the two test-only files below.
resilience/retry/idempotency.ts
22
KEEP
The live idempotency guard.
resilience/retry/policies/idempotent.policy.ts
43
DELETE-B
Imported only by ddia-transactions-suite.mjs.
resilience/retry/retry-budget.ts
36
KEEP

resilience/retry/retry-handler.ts
21
DELETE-B
Master implements retry inline; this is test-only.
Types (7 files)
File
Lines
Action
Change
types/balancer.types.ts
18
KEEP

types/common.types.ts
10
DELETE-A
Only reachable through the unused barrel.
types/config.types.ts
17
DELETE-A
Same.
types/http.types.ts
14
DELETE-A
Same.
types/index.ts
14
DELETE-A
Barrel with no importer.
types/resilience.types.ts
41
DELETE-A
Same.
types/upstream.types.ts
31
KEEP
Its requests and failures fields get populated by the load-balancer fix.
Multi-tenant capability matrix
Keeping many features is right for a platform, but only if each is safe when another tenant is on the same proxy. Today 3 of 14 tenant needs are ready, 3 are partly ready and 8 are not; 5 of those 8 wait on the P0 datapath work. Offer each capability only after its precondition is met.
Tenant need
Files
Ready today
Precondition before offering
Serve images, PDFs, downloads
worker.ts
No: binary bodies are corrupted
P0 streaming rewrite
Brotli or deflate responses
worker.ts
No: encoding header stripped
P0: pass Content-Encoding through
SSE, long polling, streaming APIs
master.ts, worker.ts
No: first byte arrives only at the end
P0 streaming rewrite
Files over about 1 MB
master.ts, worker.ts
No: 2 to 4 MB responses returned 504
P0 streaming rewrite
Non-idempotent writes (payments, orders)
master.ts, worker.ts
No: POSTs duplicated under load
P0: remove the resend loops
Isolation from other tenants' bad clients
master.ts, load-balancer.ts
No: 3 client aborts open the breaker for everyone
P1: recordAbort()
Per-tenant rate limits
rate-limiter.ts, context.ts
Partly: per IP only, and IPs are spoofable
P1 IP trust fix, P2 key function
Per-tenant API tokens
auth.middleware.ts
Partly: one shared token set
Map token to tenant id
Browser apps with cookies
cors.middleware.ts
No: credentials sent to any origin
P1 CORS fix
Cache with per-tenant purge
key-builder.ts, tag.invalidator.ts, redis.cache.ts
Partly: tag purge works; pattern purge blocks Redis and crosses tenants
P1 SCAN, tenant prefix on keys
Database-driven invalidation (CDC)
debezium.invalidator.ts, cache-manager.ts
No: events lost on reconnect, broad fallback purge
P1 Streams consumer, explicit mappings
Stateful apps (sticky sessions), WebSockets
sticky-sessions.strategy.ts, websocket.handler.ts
Yes
P2: WebSocket idle timeout
Canary and latency-aware balancing
power-of-two.strategy.ts, route config
Yes
Use power-of-two, not AdaptiveWRR, until P2
Tenant log export, tracing, metrics
tenant-log.streamer.ts, tracing, prometheus
Yes for tracing and metrics; log export has head-of-line blocking
P1 parallel flush with timeout
Open question: will tenants register their own upstreams through the admin API? If yes, the URL allowlist in admin.handler.ts becomes P0, because registration is a path to internal services.
Tests, scripts and repo hygiene
The biggest credibility risk is tests that pass against code living in the test file, not in src. Fix those before showing the repo to an interviewer.
File
Action
Change
tests/full-system-audit.mjs
EDIT (with DELETE-B)
Remove the imports on lines 37, 49 and 50, the 3 RetryHandler cases (lines 239 to 255) and the MemoryStore and HybridStore cases (lines 307 to about 320). Total drops from 183 to 174 cases (verified).
tests/ddia-transactions-suite.mjs
EDIT (with DELETE-B)
Remove imports on lines 15 and 16 and section 2 (TX-03, TX-04, lines 68 to 115). PreconditionGateway and DistributedSagaCoordinator are defined in the test; implement If-Match handling in src or label them as simulations.
tests/ddia-chapter8-distributed-troubles-suite.mjs
REWRITE
Defines its own FencingTokenTracker (line 46). Test the real module or delete the fencing section.
tests/ddia-replication-suite.mjs
MOVE
PrimarySecondaryRouter and ReadYourWritesGateway exist only here. Move to tests/simulations/ and exclude from pass totals.
tests/ddia-replication-extreme-chaos.mjs
MOVE
DisasterTolerantGateway and BoundedWriteTracker exist only here. Same treatment.
tests/aggressive-fire-test.mjs
FIX
Exit 1 when a phase throws; today it prints 2/2 and exits 0. Phase 3's mock Redis cannot complete the node-redis v5 handshake; use redis-server or skip the phase loudly. Phase 3 measures the test process's RSS, not the proxy's. The request loop overshoots (10,099 of 10,000) because it reads completed + errors across 100 concurrent senders; use one shared issued counter. Write config files to os.tmpdir().
tests/executive-showcase-suite.mjs
KEEP
Its one failure (15 MB chunked upload accepted to about 14 MB) is a real product bug, fixed by P0.
tests/adversarial-exploit-harness.mjs
FIX
Writes _adv_cfg_*.yaml into the repo root, and 9 of them are committed. Write to os.tmpdir().
scripts/deep-architecture-audit.mjs
REWRITE
Its 25 "invariants" are String.includes() checks, and the strengths list is hardcoded text. Two claims are false: zero-buffer streaming and IPC backpressure that pauses the client. Replace with calls into the behavioral regression tests, and count test importers when labelling modules isolated.
_adv_cfg_9701.yaml to _adv_cfg_9710.yaml (9 files)
DELETE
Test leftovers. Add _*_cfg_*.yaml to .gitignore.
Video Transcoding Service.svg
MOVE
Unrelated diagram in the repo root. Move it out or into docs/.
result/
MOVE
Test-result writeups. Move under docs/results/ to clean the root.
README.md
EDIT
Lines 236, 237 and 309 list deleted files. Line 236 describes the dead http.handler.ts as handling request streaming. Soften "production-grade" (line 3) and "enterprise-grade" (line 5) until P0 lands, and describe CDC as Redis pub/sub, not a stream.
README.npm.md
EDIT
Line 112's import { createServer } works only after src/lib.ts and exports are added.
Cleanup script
cleanup.sh (sent in chat) performs both delete phases and was tested end to end on a fresh clone of eedd8ff. It takes the tree from 125 to 96 source files with every suite at its previous result.
Copy it to scripts/cleanup.sh, commit it, then run:
bash scripts/cleanup.sh --phase a --dry-run   # list what would change
bash scripts/cleanup.sh --phase a             # delete, verify, stage
git diff --staged && git commit -m "chore: prune dead code (phase a)"
bash scripts/cleanup.sh --phase b             # after reviewing the test edits listed above
Phase
Removes
Edits
Verified result
a
23 source files, 9 _adv_cfg_*.yaml
3 barrel lines, 6 README tree lines, 1 .gitignore line
36 files changed, 615 lines deleted. Build pass, unit 115/115, audit 183/183, 0 dead files
b
6 source files
5 barrel lines; 9 cases in full-system-audit.mjs, TX-03 and TX-04 in ddia-transactions-suite.mjs
Audit 174/174, DDIA transactions 8/8, 0 dead files
After both phases, the other suites were unchanged: preflight 10/10, DDIA benchmarks 11/11, chaos 12/12, showcase 17/18 (the known P0 upload bug).
Safety behavior:
• Refuses to run on a dirty working tree, so rollback cannot lose your work.
• Checks every file, barrel line and test marker before changing anything; any mismatch aborts.
• Runs build and tests after changes, and resets to HEAD on failure. Tested with a forced build error: all 125 files restored, tree clean.
• Stages changes but never commits.
One manual touch-up: in the README tree, contracts/ under circuit-breaker becomes the last child after states/ is removed, so change its ├── to └──.