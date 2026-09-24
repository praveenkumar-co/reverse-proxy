#!/usr/bin/env node
/**
 * DEEP CODEBASE ENRICHMENT — reads EVERY file, adds them all to the Excalidraw diagram
 */
import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

function uid() { return randomBytes(6).toString('base64url').slice(0, 8); }

function rect(x, y, w, h, bg='transparent', stroke='#1e1e1e', sw=2) {
  return { id:uid(), type:'rectangle', x, y, width:w, height:h, angle:0,
    strokeColor:stroke, backgroundColor:bg, fillStyle:'solid', strokeWidth:sw, strokeStyle:'solid',
    roughness:0, opacity:100, groupIds:[], frameId:null, index:'b'+uid(), roundness:{type:3},
    seed:Math.random()*1e9|0, version:1, versionNonce:Math.random()*1e9|0, isDeleted:false,
    boundElements:[], updated:Date.now(), link:null, locked:false, created:null };
}

function txt(x, y, content, color='#1e1e1e', fontSize=13, w=null) {
  const lines = content.split('\n');
  const maxLen = Math.max(...lines.map(l=>l.length));
  return { id:uid(), type:'text', x, y, width:w||Math.max(maxLen*7.5,200), height:lines.length*17+8,
    angle:0, strokeColor:color, backgroundColor:'transparent', fillStyle:'solid', strokeWidth:2,
    strokeStyle:'solid', roughness:0, opacity:100, groupIds:[], frameId:null, index:'b'+uid(),
    roundness:null, seed:Math.random()*1e9|0, version:1, versionNonce:Math.random()*1e9|0, isDeleted:false,
    boundElements:[], updated:Date.now(), link:null, locked:false, created:null,
    text:content, fontSize, fontFamily:3, textAlign:'left', verticalAlign:'top', containerId:null,
    originalText:content, autoResize:true, lineHeight:1.25 };
}

function hdr(x, y, content, color='#1971c2', fontSize=17) {
  return txt(x, y, content, color, fontSize);
}

const file = 'docs/ninja-rp-new-diagram.excalidraw';
const diagram = JSON.parse(readFileSync(file,'utf8'));
const existing = diagram.elements;
console.log(`Existing elements: ${existing.length}`);
const N = [];

// ═══════════════════════════════════════════════════════════════════════════
// BIG OUTER FRAME for all new content (y: 3500 to 15000)
// x: 9440 to 17500
// ═══════════════════════════════════════════════════════════════════════════
// We place everything starting from y=3500 (below existing content which ends ~3300)

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: COMPLETE MODULE ARCHITECTURE MAP
// ═══════════════════════════════════════════════════════════════════════════
let SY = 3500;
N.push(rect(9440, SY, 8140, 400, '#e7f5ff', '#1971c2', 3));
N.push(hdr(9460, SY+10, '📦  COMPLETE MODULE ARCHITECTURE  (src/ — every file, every class, every function)', '#1971c2', 19));
N.push(txt(9460, SY+55,
`src/
├── core/
│   ├── cluster/
│   │   ├── master.ts          → Master process: HTTP+HTTPS servers, IPC, worker mgmt, hot reload, shutdown
│   │   ├── worker.ts          → Worker: IPC handler, http/https agent, proxy request, gzip, headers, metrics
│   │   └── ipc.protocol.ts   → Zod schemas: WorkerMessageType, WorkerReplyMessageType
│   ├── pipeline/
│   │   ├── middleware.pipeline.ts → MiddlewarePipeline class, compose(), run() — Express-style
│   │   └── context.ts         → RequestContext { req, res, clientIp, startTime, metadata }
│   ├── proxy/
│   │   ├── connection.pool.ts → ConnectionPool, httpAgent/httpsAgent per upstream, keepAlive pools
│   │   ├── http.handler.ts    → handleProxyRequest(), cache check, LB pick, IPC dispatch, retry
│   │   ├── upstream.client.ts → UpstreamClient class, request(), health probe
│   │   └── websocket.handler.ts → handleWebSocketUpgrade(), net.connect/tls.connect, bidirectional pipe
│   ├── router/
│   │   ├── route.matcher.ts   → RouteMatcher class, match(url) → RouteRule | null (prefix matching)
│   │   ├── route.types.ts     → RouteRule { path, upstreams[], rateLimit, sticky, cache, canary }
│   │   └── router.ts          → Router class, updateRules(), wraps RouteMatcher
│   └── admin/
│       └── admin.handler.ts   → handleAdminRequest() → /__lb-stats, /metrics, /__registry,
│                                  /__ready, /__health, /__cache-stats, /__registry/register|heartbeat|deregister
├── balancer/
│   ├── contracts/
│   │   ├── balancer.interface.ts → ILoadBalancer { pickFiltered, addUpstream, removeUpstream, getStats }
│   │   ├── context.types.ts   → BalancerContext { clientIp, cookies, attemptedIds }
│   │   └── strategy.interface.ts → IStrategy { pick(candidates, clientIp, cookies), onUpstreamsChanged? }
│   ├── core/
│   │   ├── load-balancer.ts   → LoadBalancer class (MAIN) — manages UpstreamState[], CB integration, EWMA
│   │   └── strategy-registry.ts → StrategyRegistry — Map<name, IStrategy>, register/get
│   ├── factory/
│   │   └── balancer.factory.ts → createLoadBalancer(opts) — registers all 12 strategies
│   └── strategies/ (12 strategies):
│       ├── round-robin.strategy.ts          → Simple RR index cycling
│       ├── weighted-round-robin.strategy.ts  → SWRR (Nginx smooth algo) + slowStart
│       ├── adaptive-wrr.strategy.ts          → Error rate + latency weighted + slowStart
│       ├── least-connections.strategy.ts     → min(activeConnections)
│       ├── weighted-least-connections.strategy.ts → min(activeConns/weight)
│       ├── least-response-time.strategy.ts   → min(EWMA responseTime)
│       ├── power-of-two.strategy.ts          → P2C: pick 2 random, choose min(activeConns)
│       ├── consistent-hashing.strategy.ts    → FNV-1 ring, 150 virtual nodes per upstream
│       ├── ip-hash.strategy.ts               → FNV-1a hash of clientIP mod N
│       ├── sticky-sessions.strategy.ts       → NINJA_ROUTE cookie → same upstream
│       ├── resource-based.strategy.ts        → /health JSON { cpu, mem } → min composite score
│       └── random.strategy.ts                → Math.random() pick
├── cache/
│   ├── cache-manager.ts      → Cache class: l1(InMemoryLRU) + l2(RedisCache) = HybridCache
│   ├── contracts/ (ICache, ICacheConfig, IInvalidator interfaces)
│   ├── stores/
│   │   ├── in-memory-lru.ts  → InMemoryLRU: Map<key,{value,expires}>, LRU eviction, TTL
│   │   ├── redis.cache.ts    → RedisCache: client.get/set/del, invalidate(pattern→KEYS→DEL)
│   │   └── hybrid.cache.ts   → HybridCache: L1(InMemoryLRU) + L2(Redis), graceful L2 fallback
│   ├── policies/
│   │   ├── key-builder.ts    → buildKey(method,path) → "proxy:GET:/api/users"
│   │   ├── cache-control.parser.ts → parseMaxAge(headers), parseSMaxAge(), isCacheable()
│   │   ├── stale-while-revalidate.ts → shouldRevalidate(key,age,maxAge), background refresh
│   │   └── stale-if-error.ts → shouldServeStale(errorStatus, staleIfErrorSec, ageSec)
│   └── invalidation/
│       ├── tag.invalidator.ts     → TagInvalidator: Map<tag, Set<cacheKey>>
│       ├── pattern.invalidator.ts → Pattern-based bulk invalidation
│       └── debezium.invalidator.ts → CDC-based invalidation (Debezium events)
├── config/
│   ├── config.ts             → loadConfig(path) — reads YAML, merges config.d/, Zod validates
│   ├── config.loader.ts      → ConfigLoader class, watch(fs.watch+SIGHUP), debounce 100ms
│   ├── config-schema.ts      → Re-exports RootConfigType
│   ├── server-schema.ts      → rootSchema Zod definition
│   └── schemas/
│       ├── server.schema.ts     → upstreamSchema, routeSchema, canarySchema, RootConfigType
│       ├── balancer.schema.ts   → loadBalancerSchema (strategy, failureThreshold, virtualNodes, etc)
│       ├── cache.schema.ts      → cacheSchema (enabled, host, port, ttl, l1MaxSize, mode)
│       ├── resilience.schema.ts → resilienceSchema (circuitBreaker mode/K/threshold, retry backoff)
│       ├── ratelimit.schema.ts  → rateLimitSchema (algorithm, storage, windowMs, maxRequests)
│       ├── discovery.schema.ts  → discoverySchema (heartbeatTimeoutMs, cleanupIntervalMs, persistencePath)
│       ├── admin.schema.ts      → adminSchema (port, auth, cors)
│       └── observability.schema.ts → observabilitySchema (logging, metrics, tracing, tenantDelivery)
├── discovery/
│   └── registry/
│       └── dynamic.registry.ts → ServiceRegistry class: Map<id,ServiceInstance>
│                                   register(), deregister(), heartbeat(), getHealthy(), getStats()
│                                   Persistence: proxy_registry_backup.json (atomic rename)
│                                   Cleanup: setInterval(checkHeartbeats, 10s)
│                                   Callbacks: onRegister, onDeregister
├── middleware/
│   ├── circuit.middleware.ts  → circuitMiddleware(isOpen) → 503 if circuit open
│   ├── cors.middleware.ts     → CORS headers, OPTIONS preflight 204
│   ├── logging.middleware.ts  → loggingMiddleware() → "METHOD URL status latencyMs"
│   ├── rate-limit.middleware.ts → rateLimitMiddleware(config) → 429 + Retry-After header
│   └── tracing.middleware.ts  → tracingMiddleware() → X-Trace-Id header, Tracer.startSpan/endSpan
├── observability/
│   ├── health/
│   │   └── readiness.ts      → ReadinessProbe: register(check), isReady() → {ready,checks}
│   ├── logger/
│   │   ├── logger.ts         → Logger class: info/warn/error, TTY colors, file append
│   │   │                       writeAccessLog(path,ip,method,url,status,bytes,latency,ua)
│   │   └── tenant-log.streamer.ts → TenantLogStreamer: webhook delivery per tenantId
│   │                                 queue Map<tenantId,entries[]>, maxTenantQueue=10000, maxGlobal=50000
│   │                                 flush() every 1s, POST to destination with X-Tenant-ID header
│   ├── metrics/
│   │   ├── prometheus.exporter.ts → MetricsRegistry: counters/gauges/histograms, getExpositionFormat()
│   │   │                            mergeSnapshot() for worker aggregation
│   │   ├── histogram.registry.ts  → Histogram class: boundaries[5,10,25,50,100,250,500,1000,2500,5000]ms
│   │   │                            HistogramRegistry: getOrCreate(), toPrometheusAll(), mergeAll()
│   │   └── system.metrics.ts      → collectSystemMetrics(): cpu/mem/loadAvg/uptime
│   │                                systemMetricsToPrometheus(): ninja_proxy_cpu_load, memory, uptime
│   └── tracing/
│       └── tracer.ts         → Tracer class: startSpan(name,traceId,attrs), endSpan(span), flush()
│                               Span { traceId, spanId, name, startMs, endMs, attributes }
├── ratelimit/
│   ├── algorithms/
│   │   ├── fixed-window.ts          → Map<key,{count,resetTime}> — count++ per window
│   │   ├── sliding-window-log.ts    → Map<key,timestamps[]> — filter old, count < max
│   │   ├── sliding-window-counter.ts → Map<key,{current,prev,windowStart}> — weighted estimate
│   │   │                               weight=(windowMs-timeIntoWindow)/windowMs, estimated=prev*w+curr
│   │   ├── token-bucket.ts          → Map<key,{tokens,lastRefill}> — rate=max/windowMs, elapsed refill
│   │   └── leaking-bucket.ts        → Map<key,{water,lastLeak}> — constant leak rate, overflow=429
│   ├── contracts/ (ILimiter, IRateLimitStore interfaces)
│   ├── policies/
│   │   └── soft-limit.policy.ts     → SoftLimitPolicy: effectiveLimit(load) → burst if < softLimit
│   ├── storage/
│   │   ├── memory.store.ts   → MemoryStore: Map<key,{count,resetTime}>
│   │   ├── redis.store.ts    → RedisStore: incr(key)→pExpire, count, reset
│   │   └── hybrid.store.ts   → HybridStore: L1(memory) + L2(redis), graceful fallback
│   └── rate-limiter.ts       → RateLimiter class: factory for all 5 algorithms + 3 storage backends
└── resilience/
    ├── bulkhead/
    │   └── bulkhead.ts        → Bulkhead(maxConcurrent): execute(fn), enter()/leave()
    │                            → throws "Bulkhead capacity reached" when full
    ├── circuit-breaker/
    │   ├── classic.circuit-breaker.ts → ClassicCircuitBreaker(failureThreshold, recoveryTimeMs)
    │   │                               CLOSED→OPEN on failures≥threshold, HALF_OPEN after recovery
    │   ├── adaptive.circuit-breaker.ts → AdaptiveCircuitBreaker(K=2, decayFactor=0.9)
    │   │                                  Google SRE model: p(drop) = max(0, (req-K*accepts)/(req+1))
    │   │                                  EWMA decay on both requests and accepts counters
    │   ├── circuit-breaker.manager.ts → CircuitBreakerManager: Map<id,ICircuitBreaker>
    │   │                               getOrCreate(id, mode, options) → singleton per upstream
    │   ├── contracts/ (ICircuitBreaker interface)
    │   └── states/ (closed.state.ts, open.state.ts, half-open.state.ts — state pattern)
    ├── retry/
    │   ├── backoff/
    │   │   ├── exponential.backoff.ts         → min(maxDelay, base * 2^attempt)
    │   │   ├── full-jitter.backoff.ts         → Math.random() * exponential
    │   │   ├── equal-jitter.backoff.ts        → halfLimit + Math.random() * halfLimit
    │   │   └── decorrelated-jitter.backoff.ts → base + Math.random()*(prev*3 - base)
    │   ├── contracts/ (IRetryPolicy interface)
    │   ├── retry-handler.ts  → RetryHandler(policy): execute(fn, maxAttempts) with delay
    │   └── retry-budget.ts   → RetryBudget(budgetPercent=15, decayFactor=0.9)
    │                           recordRequest(), recordRetry() → false if >15% retry ratio
    │                           EWMA decay on totalRequests and totalRetries
    └── index.ts`, '#1e1e1e', 12, 8100));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: LOAD BALANCER DEEP DIVE — ALL 12 STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════
SY = 3500 + 420;
N.push(rect(9440, SY, 8140, 1050, '#fff9db', '#e67700', 3));
N.push(hdr(9460, SY+10, '⚖️  LOAD BALANCER — ALL 12 STRATEGIES  (src/balancer/strategies/)', '#e67700', 19));

// col 1
N.push(rect(9460, SY+60, 1970, 970, '#fffacd', '#e67700'));
N.push(txt(9460, SY+65,
`ROUND-ROBIN (src/balancer/strategies/round-robin.strategy.ts)
──────────────────────────────────────────────────────────────
private index = 0;
pick(candidates[]) {
  const chosen = candidates[index % length];
  index++;
  return chosen;
}
→ Simple cycle, equal distribution

WEIGHTED ROUND-ROBIN (weighted-round-robin.strategy.ts)
───────────────────────────────────────────────────────
Nginx Smooth WRR algorithm:
Per pick():
  forEach upstream s:
    s.currentWeight += s.weight
  best = max(currentWeight)
  best.currentWeight -= totalWeight
  return best
+ slowStart: weight ramps from 0→max
  over slowStartSeconds (default 30s)

ADAPTIVE WRR (adaptive-wrr.strategy.ts)
────────────────────────────────────────
Dynamic weight = max(1, round(
  weight
  * (1 / (1 + responseTime/100))
  * (1 - errorRate)
))
errorRate = failures / (requests + 1)
slowStart: weight * progress (0→1)
progress = 1 - timeLeft/slowStartMs
Weighted random selection`, '#1e1e1e', 12, 1950));

// col 2
N.push(rect(11470, SY+60, 1970, 970, '#e8f5e9', '#2f9e44'));
N.push(txt(11470, SY+65,
`LEAST CONNECTIONS (least-connections.strategy.ts)
──────────────────────────────────────────────────
pick = min(activeConnections) among candidates

WEIGHTED LEAST CONNECTIONS (weighted-least-connections.strategy.ts)
────────────────────────────────────────────────────────────────────
score = activeConnections / weight
pick = min(score)

LEAST RESPONSE TIME (least-response-time.strategy.ts)
──────────────────────────────────────────────────────
Uses EWMA latency tracked by LoadBalancer:
  responseTime = α*latency + (1-α)*prevTime
  α (ewmaAlpha) = default 0.3
pick = min(EWMA responseTime)

POWER OF TWO (power-of-two.strategy.ts)
─────────────────────────────────────────
i1 = random, i2 = random (i2 ≠ i1)
a = candidates[i1], b = candidates[i2]
return a.activeConns <= b.activeConns ? a : b
→ P2C: reduces worst-case vs pure random

STICKY SESSIONS (sticky-sessions.strategy.ts)
──────────────────────────────────────────────
Read NINJA_ROUTE cookie (configurable name)
If cookie matches upstream id → return that upstream
Set-Cookie: NINJA_ROUTE=id; Path=/; HttpOnly
Falls back to round-robin if not found`, '#1e1e1e', 12, 1950));

// col 3
N.push(rect(13480, SY+60, 2050, 970, '#f3e5f5', '#7950f2'));
N.push(txt(13480, SY+65,
`IP HASH (ip-hash.strategy.ts)
──────────────────────────────────────────────────────────────
FNV-1a 32-bit:
  hash = 2166136261
  for each byte of clientIP:
    hash ^= byte
    hash = (hash * 16777619) >>> 0
  idx = hash % candidates.length

CONSISTENT HASHING (consistent-hashing.strategy.ts)
─────────────────────────────────────────────────────
ring = Map<hash, UpstreamState> (sorted)
virtualNodes = 150 (configurable)
On addUpstream(id):
  for i in 0..149: fnv1a("id:i") → insert in ring
lookup(clientIP):
  h = fnv1a(clientIP)
  ceiling entry ≥ h → upstream
  wraps to first if h > max

RESOURCE-BASED (resource-based.strategy.ts)
─────────────────────────────────────────────
GET upstream.healthPath → { cpu: %, mem: % }
score = cpu + mem (composite load score)
pick = min(score) among candidates
Falls back to first if /health unavailable

RANDOM (random.strategy.ts)
────────────────────────────
candidates[Math.random() * length | 0]

ADAPTIVE CIRCUIT BREAKER (Google SRE model)
─────────────────────────────────────────────
p(drop) = max(0, (req - K*accepts) / (req+1))
K=2: drops when accept rate < 50%
EWMA decay: requests *= 0.9, accepts *= 0.9
recordSuccess: both += 1
recordFailure: only requests += 1`, '#1e1e1e', 12, 2020));

// col 4 (canary)
N.push(rect(15570, SY+60, 1970, 970, '#ffe0e0', '#c2255c'));
N.push(txt(15570, SY+65,
`CANARY DEPLOYMENT (v1.2.0)
──────────────────────────────────────────────────────────
Configured per-path in config.yaml:
  canary:
    enabled: true
    canaryUpstream: "backend-canary"
    baselineUpstream: "backend-stable"
    weight: 10          (10% to canary)
    stickyCookieName: "NINJA_CANARY"
    headerKey: "x-canary"
    headerValue: "true"
    stage: "canary"

Routing logic:
1. Header match: x-canary: "true" → canary
2. Cookie match: NINJA_CANARY=1 → canary
3. Random < weight/100 → canary → set cookie
4. else → baseline upstream

Set-Cookie: NINJA_CANARY=1; Path=/; HttpOnly
(sticky for session duration)

UPSTREAM STATE (UpstreamState type)
──────────────────────────────────────
{
  id: string
  weight: number          (config static)
  activeConnections: number
  failures: number
  state: "CLOSED"|"OPEN"|"HALF_OPEN"
  lastFailureTime: number
  responseTime: number    (EWMA latency)
  healthy: boolean        (health probe)
  requests: number        (EWMA decayed)
  accepts: number         (EWMA decayed)
  slowStartEndTime: number
  maxConnections?: number (connection cap)
  currentWeight: number   (SWRR state)
  url?: string
  totalBytes?: number     (bandwidth LB)
}`, '#1e1e1e', 12, 1950));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: RESILIENCE LAYER — Circuit Breaker + Retry + Bulkhead
// ═══════════════════════════════════════════════════════════════════════════
SY += 1080;
N.push(rect(9440, SY, 8140, 700, '#fff0f6', '#c2255c', 3));
N.push(hdr(9460, SY+10, '🛡️  RESILIENCE LAYER  (src/resilience/) — Circuit Breaker + Retry + Bulkhead', '#c2255c', 19));

N.push(rect(9460, SY+55, 2580, 620, '#ffe0e0', '#c2255c'));
N.push(txt(9460, SY+60,
`CLASSIC CIRCUIT BREAKER (classic.circuit-breaker.ts)
──────────────────────────────────────────────────────────
ClassicCircuitBreaker(failureThreshold, recoveryTimeMs)
State machine:
  CLOSED (normal operation)
    └── recordFailure() → failures++
        failures >= threshold → OPEN + timestamp
  OPEN (reject all requests)
    └── isAllowed(): now - lastFail >= recoveryMs
        → HALF_OPEN (allow 1 probe)
  HALF_OPEN (test probe)
    └── recordSuccess() → failures=0, CLOSED
        recordFailure() → OPEN again

Integration with LoadBalancer:
  pickFiltered() priority: HALF_OPEN > CLOSED
  OPEN → skip upstream entirely
  OPEN→CLOSED transition: reset currentWeight
  Slow start: slowStartEndTime = now + 30s

ADAPTIVE CIRCUIT BREAKER (adaptive.circuit-breaker.ts)
────────────────────────────────────────────────────────
Google SRE Client-Side Throttling model
AdaptiveCircuitBreaker(K=2, decayFactor=0.9)
EWMA state:
  requests = req * 0.9 + 1   (on each req)
  accepts  = acc * 0.9 + 1   (on success)
  accepts  = acc * 0.9        (on failure)

isAllowed():
  p = max(0, (req - K*acc) / (req + 1))
  if p > 0: Math.random() >= p  (probabilistic)
  K=2 means: drops when accept < 50%
  K=1: more aggressive throttling

CircuitBreakerManager (circuit-breaker.manager.ts)
───────────────────────────────────────────────────
Singleton map: Map<upstreamId, ICircuitBreaker>
getOrCreate(id, "classic"|"adaptive", options)
→ one CB per upstream, persists through request lifecycle`, '#1e1e1e', 12, 2560));

N.push(rect(12080, SY+55, 2580, 620, '#e8eaf6', '#3f51b5'));
N.push(txt(12080, SY+60,
`RETRY HANDLER + BUDGET (src/resilience/retry/)
────────────────────────────────────────────────────
RetryHandler(policy: IRetryPolicy)
  execute<T>(fn, maxAttempts):
    for attempt in 0..maxAttempts-1:
      try: return await fn()
      catch err:
        if !policy.shouldRetry(attempt, err) break
        delay = policy.getDelay(attempt)
        await sleep(delay)
    throw lastError

4 BACKOFF STRATEGIES:
  Exponential: min(maxDelay, base * 2^attempt)
  Full Jitter:  Math.random() * exponential
  Equal Jitter: halfLimit + Math.random() * halfLimit
  Decorrelated Jitter:
    prev = previousSleep ?? base
    next = base + Math.random() * (prev*3 - base)
    return min(maxDelay, next)

RETRY BUDGET (retry-budget.ts) — Global SRE Budget
───────────────────────────────────────────────────
RetryBudget(budgetPercent=15, decayFactor=0.9)
  recordRequest():
    totalRequests = totalRequests * 0.9 + 1
    totalRetries  = totalRetries * 0.9
  recordRetry() → boolean:
    ratio = (retries+1) / (requests+1)
    if ratio > budgetPercent/100: return false
    (budget exhausted — drop retry)
    totalRetries = retries * 0.9 + 1
    return true
→ Prevents retry storms in distributed system
globalRetryBudget = new RetryBudget()

BULKHEAD (bulkhead.ts)
───────────────────────────────────────────────────
Bulkhead(maxConcurrent: number)
  execute<T>(fn): Promise<T>
    if activeCount >= maxConcurrent:
      throw "Bulkhead capacity reached"
    activeCount++
    try: return await fn()
    finally: activeCount--
  enter() → boolean (non-async variant)
  leave() → void
→ Isolates failure domains, limits concurrency`, '#1e1e1e', 12, 2560));

N.push(rect(14700, SY+55, 2840, 620, '#f1f8e9', '#2f9e44'));
N.push(txt(14700, SY+60,
`RATE LIMITER — 5 ALGORITHMS (src/ratelimit/algorithms/)
────────────────────────────────────────────────────────
Configurable per-path in config.yaml:
  rateLimit:
    algorithm: "fixed-window" | "sliding-window-log"
             | "sliding-window-counter" | "token-bucket"
             | "leaking-bucket"
    storage: "memory" | "redis" | "hybrid"
    windowMs: 60000
    maxRequests: 100

FIXED WINDOW: Map<key,{count,resetTime}>
  if now >= resetTime → reset count=0
  if count < max → count++ → allow

SLIDING WINDOW LOG: Map<key,timestamps[]>
  filter timestamps > (now - windowMs)
  if length < max → push(now) → allow

SLIDING WINDOW COUNTER: Map<key,{curr,prev,wStart}>
  weight = (windowMs - elapsed) / windowMs
  estimated = floor(prev * weight + curr)
  if estimated < max → curr++ → allow
  → O(1) memory, approximation of log

TOKEN BUCKET: Map<key,{tokens,lastRefill}>
  elapsed = now - lastRefill
  rate = maxRequests / windowMs
  tokens = min(max, tokens + elapsed * rate)
  if tokens >= 1 → tokens-- → allow

LEAKING BUCKET: Map<key,{water,lastLeak}>
  elapsed = now - lastLeak
  leaked = elapsed * (max / windowMs)
  level = max(0, water - leaked)
  if level + 1 <= max → water=level+1 → allow

3 STORAGE BACKENDS:
  MemoryStore: simple Map (per-worker, non-distributed)
  RedisStore:  client.incr(key) → pExpire(windowMs)
  HybridStore: L1(memory) fast path + L2(redis) sync
    → graceful degradation to L1 if redis down
    → async redis writes (fire-and-forget)

SOFT LIMIT POLICY (soft-limit.policy.ts):
  SoftLimitPolicy(hardLimit, softLimit, burstMultiplier=1.5)
  if currentLoad < softLimit:
    effectiveLimit = floor(hardLimit * 1.5)  ← burst allowed
  else: effectiveLimit = hardLimit

RESPONSE HEADERS ON 429:
  Retry-After: <windowMs/1000>s
  X-RateLimit-Limit: maxRequests
  X-RateLimit-Remaining: 0`, '#1e1e1e', 12, 2820));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: CACHE — L1+L2 Hybrid + Policies + Invalidation
// ═══════════════════════════════════════════════════════════════════════════
SY += 730;
N.push(rect(9440, SY, 8140, 680, '#e3f2fd', '#1976d2', 3));
N.push(hdr(9460, SY+10, '🗃️  CACHE SYSTEM — L1+L2 Hybrid + Policies + Invalidation  (src/cache/)', '#1976d2', 19));

N.push(rect(9460, SY+55, 2700, 600, '#bbdefb', '#1976d2'));
N.push(txt(9460, SY+60,
`HYBRID CACHE ARCHITECTURE (cache-manager.ts)
─────────────────────────────────────────────────
L1: InMemoryLRU (in-process, sub-ms)
  Map<key, {value, expires}>
  LRU eviction: delete oldest when maxSize hit
  TTL: expires = Date.now() + ttl*1000
  invalidatePattern(pattern): regex glob→regex
  getStats(): { size, maxSize }

L2: RedisCache (shared across workers)
  client.get(key) → string | null
  client.set(key, value, {EX: ttl})
  client.del(key)
  invalidate(pattern):
    searchPatterns = [pat, "*pat*", "proxy:*:pat"]
    allKeys = Set (KEYS queries)
    client.del([...allKeys])
  buildKey(method, path) → "proxy:GET:/api/users"

HybridCache: L1 read-through → L2
  get: L1 hit? return | else L2 → populate L1
  set: L1.set + try L2.set (L2 failure = continue)
  del: L1.del + try L2.del
  invalidate: L1.invalidatePattern + try L2.invalidate

Cache.getStats():
  { l1: {size, maxSize}, l2: {connected} }`, '#1e1e1e', 12, 2680));

N.push(rect(12200, SY+55, 2600, 600, '#c8e6c9', '#2f9e44'));
N.push(txt(12200, SY+60,
`CACHE POLICIES (src/cache/policies/)
──────────────────────────────────────────────────────
key-builder.ts:
  buildKey(method, path) → "proxy:METHOD:path"

cache-control.parser.ts:
  parseMaxAge(headers) → number | null
    Cache-Control: max-age=N → N
    Cache-Control: s-maxage=N (CDN TTL)
  isCacheable(method, status):
    method: GET only
    status: 200, 203, 204, 206, 300, 301, 404, 410

stale-while-revalidate.ts:
  StaleWhileRevalidate:
    shouldRevalidate(key, age, maxAge):
      age > maxAge && !revalidating.has(key)
    markRevalidating(key) / markDone(key)
  → Serve stale while background refresh happens
  → Only one concurrent revalidation per key

stale-if-error.ts:
  StaleIfError:
    shouldServeStale(errorStatus, sieSeconds, age):
      isError = status >= 500 || status === 0
      return isError && age <= sieSeconds
  → Serves cached response on upstream failure

CACHE INVALIDATION STRATEGIES (src/cache/invalidation/)
──────────────────────────────────────────────────────────
TagInvalidator (tag.invalidator.ts):
  Map<tag, Set<cacheKey>>
  tag(cacheKey, tags[]) → maps each tag→key
  getKeysForTag(tag) → cacheKey[]
  removeTag(tag)
  → Group-based invalidation (e.g. by resource type)

PatternInvalidator (pattern.invalidator.ts):
  Glob pattern → Redis KEYS → bulk DEL

DebeziumInvalidator (debezium.invalidator.ts):
  CDC event → parse table/row change
  → Invalidate related cache keys
  → For DB-to-cache consistency`, '#1e1e1e', 12, 2580));

N.push(rect(14840, SY+55, 2700, 600, '#fce4ec', '#c2255c'));
N.push(txt(14840, SY+60,
`SERVICE REGISTRY — COMPLETE API (src/discovery/registry/)
────────────────────────────────────────────────────────────
ServiceRegistry(config: RegistryConfig)
  heartbeatTimeoutMs: 30000
  cleanupIntervalMs: 10000
  persistencePath: "proxy_registry_backup.json"

PERSISTENCE (atomic write):
  On register/deregister:
    tmpFile = "backup.json.tmp.PID.ts.rand"
    fs.writeFile(tmpFile, JSON)
    fs.rename(tmpFile, persistencePath)
  On startup: loadSnapshot() rehydrates from file
  → Survives proxy restarts!

METHODS:
  register({ id, url, metadata? }):
    ServiceInstance { id, url, registeredAt,
      lastHeartbeat, status:"UP", metadata }
    → calls onRegisterCallbacks[]
    → saves snapshot
  deregister(id):
    status="DOWN", delete from map
    → calls onDeregisterCallbacks[]
    → saves snapshot
  heartbeat(id):
    lastHeartbeat = Date.now()
    status = "UP"
  getHealthy():
    filter status === "UP"
  checkHeartbeats() [every 10s]:
    if now - lastHeartbeat > timeoutMs
    → status = "DOWN"
  onRegister(callback) / onDeregister(callback)
  getAll() / get(id) / getStats()

ADMIN ENDPOINTS:
  GET  /__registry → registry.getStats()
  POST /__registry/register { id, url, metadata }
  PUT  /__registry/heartbeat/:id
  DELETE /__registry/deregister/:id`, '#1e1e1e', 12, 2680));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: OBSERVABILITY — Metrics + Tracing + Logging
// ═══════════════════════════════════════════════════════════════════════════
SY += 710;
N.push(rect(9440, SY, 8140, 720, '#f3e5f5', '#7b1fa2', 3));
N.push(hdr(9460, SY+10, '📊  OBSERVABILITY — Metrics + Tracing + Logging + Health  (src/observability/)', '#7b1fa2', 19));

N.push(rect(9460, SY+55, 2700, 640, '#e1bee7', '#7b1fa2'));
N.push(txt(9460, SY+60,
`PROMETHEUS METRICS (prometheus.exporter.ts)
─────────────────────────────────────────────────
MetricsRegistry class:
  recordRequest(method, url, status, upstreamId,
                latencyMs, tenantId)
  recordActiveConnection(upstreamId, delta)
  recordCacheOp(hit|miss)
  mergeSnapshot(snapshot) [worker aggregation]
  getSnapshot() → plain object (IPC-safe)
  getExpositionFormat(allUpstreams, tenantFilter)

PROMETHEUS METRICS EXPOSED:
  ninja_http_requests_total
    {method, path, status, upstream_id, tenant_id}
  ninja_http_request_duration_ms (histogram)
    boundaries: [5,10,25,50,100,250,500,1000,2500,5000]
    {upstream_id, method, path, tenant_id}
  ninja_active_connections{upstream_id}
  ninja_cache_operations_total{action=hit|miss}
  ninja_upstream_status{upstream_id}  1=UP/0=DOWN
  ninja_proxy_cpu_load
  ninja_proxy_memory_used_mb
  ninja_proxy_memory_total_mb
  ninja_proxy_uptime_seconds

HISTOGRAM REGISTRY (histogram.registry.ts):
  HistogramRegistry: Map<name, Histogram>
  Histogram.observe(value): bucketed count + sum
  toPrometheus(name, labels): _bucket/_sum/_count
  HistogramRegistry.mergeAll(snapshots) [aggregation]

GET /metrics?tenant=<id>  → per-tenant filter
GET /__metrics             → same endpoint

WORKER METRIC AGGREGATION:
  Master sends IPC to all workers → getSnapshot()
  aggregatedRegistry.mergeSnapshot(each)
  Total = master + all worker snapshots
  → Accurate distributed counts`, '#1e1e1e', 12, 2680));

N.push(rect(12200, SY+55, 2700, 640, '#e8f5e9', '#2e7d32'));
N.push(txt(12200, SY+60,
`DISTRIBUTED TRACING (tracer.ts)
─────────────────────────────────────────────────
Tracer class (in-memory, exportable):
  spans: Span[] = []
  startSpan(name, traceId, attributes):
    spanId = Math.random().toString(36).slice(2)
    Span { traceId, spanId, name, startMs,
           endMs, attributes }
  endSpan(span): span.endMs = Date.now()
  flush(): Span[] (drains span buffer)

tracingMiddleware():
  traceId = X-Trace-Id header || crypto.randomUUID()
  Sets ctx.req.headers["x-trace-id"] = traceId
  Sets response header X-Trace-Id
  span = tracer.startSpan("METHOD URL", traceId, {ip, path})
  ctx.metadata["span"] = span
  try { await next() } finally { tracer.endSpan(span) }

LOGGING (logger.ts):
─────────────────────────────────────────────────
Logger class (singleton: logger):
  configure({ eventLogPath, minLevel })
  info/warn/error(source, message, meta?)
  writeAccessLog(path, ip, method, url,
                  status, bytes, latency, ua)

Log levels: INFO(0) WARN(1) ERROR(2)
TTY Colors: INFO=cyan, WARN=yellow, ERROR=red
File logging: async fs.appendFile (non-blocking)
Access log format (nginx-style):
  "IP - - [ISO] METHOD URL HTTP/1.1 STATUS BYTES
   - UA latencyMs"

TENANT LOG STREAMER (tenant-log.streamer.ts):
  TenantLogStreamer:
    queue: Map<tenantId, TenantLogEntry[]>
    endpoints: Map<tenantId, webhookURL>
    MAX_TENANT_QUEUE = 10,000 entries
    MAX_GLOBAL_QUEUE = 50,000 entries
    flush() every 1s:
      POST to webhookURL with X-Tenant-ID header
      Body: { tenantId, logs: TenantLogEntry[] }
    Backpressure: drops if queue full
    tenantLogStreamer.configure(endpoints[])
    tenantLogStreamer.queueLog(tenantId, entry)`, '#1e1e1e', 12, 2680));

N.push(rect(14940, SY+55, 2600, 640, '#fff8e1', '#f57f17'));
N.push(txt(14940, SY+60,
`HEALTH & READINESS (readiness.ts)
─────────────────────────────────────────────────
ReadinessProbe class (singleton: readinessProbe):
  checks: ReadinessCheck[] = []
  register({ name, check: async()=>boolean })
  isReady():
    for each check: try { result = await check() }
    catch → result = false
    return { ready: all && true, checks: Record }

Registered checks (from master.ts):
  "redis" → cache.ping() (if cache enabled)
  "upstreams" → healthyUpstreams.size > 0
  Custom health checks via config

Endpoints:
  GET /__ready  → isReady() → 200|503
  GET /__health → same as /__ready

K8s Probes:
  readinessProbe: GET /__lb-stats (or /__ready)
  livenessProbe:  GET /__lb-stats

ADMIN HANDLER (admin.handler.ts) — all endpoints:
  GET  /__lb-stats → strategy, upstreams[], retryBudget
  GET  /metrics[?tenant=X] → Prometheus exposition
  GET  /__registry → ServiceInstance[]
  GET  /__ready → ReadinessProbe.isReady()
  GET  /__health → same
  GET  /__cache-stats → cache.getStats()
  POST /__registry/register { id, url, metadata }
  PUT  /__registry/heartbeat/:id
  DELETE /__registry/deregister/:id

CORS MIDDLEWARE (cors.middleware.ts):
  corsMiddleware(origins=['*'])
  OPTIONS → 204 with CORS headers
  Access-Control-Allow-Origin: origin
  Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
  Access-Control-Allow-Headers: *
  Access-Control-Allow-Credentials: true

MIDDLEWARE PIPELINE (middleware.pipeline.ts):
  MiddlewarePipeline: fn[] chain
  use(middleware) → push to chain
  run(ctx): compose(fns)(ctx)
  → Express-style next() chaining
  Applied in master.ts per request`, '#1e1e1e', 12, 2580));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: CONFIG SCHEMA — COMPLETE ZOD VALIDATION
// ═══════════════════════════════════════════════════════════════════════════
SY += 750;
N.push(rect(9440, SY, 8140, 700, '#e8f5e9', '#2f9e44', 3));
N.push(hdr(9460, SY+10, '⚙️  COMPLETE CONFIG SCHEMA  (src/config/schemas/) — Zod Validation', '#2f9e44', 19));

N.push(txt(9460, SY+55,
`RootConfigType (server.schema.ts + all sub-schemas) — Full Zod-validated config:

server:
  listen: number               # HTTP port (default 8080)
  port: number                 # alias for listen
  httpsPort: number            # HTTPS port (default 8443)
  workers: number              # cluster.fork() count
  connectTimeoutMs: number     # upstream connect timeout (default 5000ms)
  readTimeoutMs: number        # upstream read timeout (default 30000ms)
  compression: boolean         # gzip response if client accepts
  headers: {key,value}[]       # custom headers to inject
  tls: { cert, key, ca? }
  upstreams[]:
    id: string
    url: string (URL validated)
    weight: number (default 1)
    healthPath: string (default "/health")
    maxConnections?: number     # per-upstream connection cap
    tls?: { rejectUnauthorized, ca? }
  paths[]:
    path: string                # prefix match (e.g. "/api")
    upstreams: string[]         # upstream IDs for this route
    sticky: boolean             # NINJA_ROUTE cookie
    rateLimit?:                 # per-path rate limiting
      algorithm: "fixed-window"|"sliding-window-log"|
                 "sliding-window-counter"|"token-bucket"|"leaking-bucket"
      storage: "memory"|"redis"|"hybrid"
      windowMs: number
      maxRequests: number
    cache?:
      enabled: boolean
      ttlSeconds: number
    canary?:                    # A/B / canary routing
      enabled: boolean
      canaryUpstream: string
      baselineUpstream?: string
      weight: 0-100             # % to canary
      stickyCookieName: "NINJA_CANARY"
      headerKey?: string        # force canary by header
      headerValue?: string
      stage: string

loadBalancing (balancer.schema.ts):
  strategy: "round-robin"|"weighted-round-robin"|"adaptive-wrr"|
            "least-connections"|"weighted-least-connections"|
            "least-response-time"|"power-of-two"|"consistent-hashing"|
            "ip-hash"|"sticky-sessions"|"resource-based"|"random"
  failureThreshold: number      # CB opens after N failures
  recoveryTimeMs: number        # CB half-open delay
  virtualNodes: number          # consistent hash virtual nodes (default 150)
  ewmaAlpha: number             # EWMA smoothing (default 0.3)
  stickyCookieName: string      # sticky session cookie name
  slowStartSeconds: number      # new upstream ramp time (default 30)
  circuitBreaker:
    mode: "classic" | "adaptive"
    failureThreshold: number
    recoveryTimeMs: number
    K: number                   # adaptive CB aggressiveness (default 2)
    windowMs: number

cache (cache.schema.ts):
  enabled: boolean
  host: string                  # Redis host
  port: number                  # Redis port
  ttlSeconds: number            # default TTL
  l1MaxSize: number             # InMemoryLRU max entries
  mode: "l1-only"|"l2-only"|"hybrid"

resilience (resilience.schema.ts):
  retry:
    backoff: "exponential"|"full-jitter"|"equal-jitter"|"decorrelated-jitter"
    baseDelayMs: number
    maxDelayMs: number
    maxAttempts: number
    budgetPercent: number       # global retry budget (default 15%)

rateLimit (ratelimit.schema.ts):
  [global defaults — overridden per-path]

discovery (discovery.schema.ts):
  heartbeatTimeoutMs: number    # service eviction (default 30000)
  cleanupIntervalMs: number     # GC interval (default 10000)
  persistencePath: string       # snapshot file path

observability (observability.schema.ts):
  logging:
    level: "INFO"|"WARN"|"ERROR"
    accessLog: boolean | string   # path to access log file
    eventLog: string              # path to event log file
  metrics:
    enabled: boolean
    path: "/metrics"
  tracing:
    enabled: boolean
  tenantDelivery:
    mode: "webhook"
    endpoints: [{tenantId, destination}]

admin (admin.schema.ts):
  [future: auth, cors overrides, rate limits for admin]`, '#1e1e1e', 12, 8100));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: REQUEST PIPELINE — Complete Flow with All Middleware
// ═══════════════════════════════════════════════════════════════════════════
SY += 730;
N.push(rect(9440, SY, 8140, 760, '#e0f7fa', '#0097a7', 3));
N.push(hdr(9460, SY+10, '🔄  COMPLETE REQUEST PIPELINE — Every Step Every Middleware', '#0097a7', 19));

N.push(rect(9460, SY+55, 3900, 680, '#b2ebf2', '#0097a7'));
N.push(txt(9460, SY+60,
`MASTER PROCESS REQUEST HANDLER (src/core/cluster/master.ts)
────────────────────────────────────────────────────────────────────────────────
HTTPS request → requestHandler(req, res):

1. Extract clientIP:
   req.headers["x-forwarded-for"] || req.socket.remoteAddress

2. Admin endpoint check:
   handleAdminRequest(options) → handled? return

3. Middleware Pipeline (MiddlewarePipeline):
   a. tracingMiddleware()
      → X-Trace-Id header (propagate or generate UUID)
      → tracer.startSpan(method+url, traceId, {ip, path})
   b. corsMiddleware(origins)
      → OPTIONS? → 204 preflight
      → Set CORS headers
   c. loggingMiddleware()
      → after next(): log METHOD URL status latencyMs
   d. rateLimitMiddleware (per-path config)
      → rateLimiter.check(clientIP, maxReq, windowMs)
      → 429 + Retry-After header if exceeded

4. Route matching:
   router.match(req.url) → RouteRule | null
   No match → 404

5. Cache check (if route.cache.enabled):
   key = buildKey(method, url)
   L1 check (InMemoryLRU) → HIT: return
   L2 check (Redis) → HIT: populate L1, return
   MISS: continue

6. Canary routing (if route.canary.enabled):
   Header/cookie/random weight split → upstream selection

7. LB pick:
   lb.pickFiltered(healthyUpstreams, clientIP, attempted, cookies)
   → Filters: health check, CB state, maxConnections, attempts
   → HALF_OPEN priority → strategy.pick(candidates)

8. IPC dispatch to worker:
   worker = workers[roundRobinIndex % N]
   requestId = crypto.randomUUID()
   worker.send(JSON.stringify({
     requestType, headers, body, url, requestId, clientIp
   }))
   replyHandlers.set(requestId, { res, upstream, startTime })
   timeout = setTimeout(504, readTimeoutMs)

9. Worker processes request (see Worker section)

10. Master receives worker reply:
    worker.on("message", msg):
      { requestId, data, statusCode, headers, error?, errorCode? }
      clearTimeout(timeout)
      replyHandler = replyHandlers.get(requestId)
      if errorCode "502"|"503":
        attempted.add(upstreamId)
        if attempted.size < maxAttempts: retry from step 7
      res.writeHead(statusCode, headers)
      res.end(isCompressed ? Buffer(data,"base64") : data)

11. Post-request:
    lb.recordSuccess(id, latency) OR lb.recordFailure(id)
    lb.releaseConnection(id)
    cache.set(key, body, ttl) if GET + 200 + enabled

WORKER PROCESSING (src/core/cluster/worker.ts):
────────────────────────────────────────────────────────────────────────────────
process.on("message", handler):
  msg = JSON.parse(raw)  → WorkerMessageType (Zod-validated)
  upstreamUrl = config.server.upstreams[selectedId].url
  isHttps = upstreamUrl.startsWith("https")
  agent = isHttps ? httpsAgent : httpAgent  (module-level pools)
  
  Build forwardHeaders:
    DELETE: transfer-encoding, connection, keep-alive
    SET: host, X-Real-IP, X-Forwarded-For (appended),
         X-Forwarded-Proto, X-Forwarded-Host, X-Forwarded-Port,
         X-Trace-Id (if present), X-Proxy-By: "Ninja-Reverse-Proxy"
    Custom headers from config.server.headers[]
    content-length: Buffer.byteLength(body)

  transport.request(options, callback):
    Chunks: upstreamRes.on("data", chunk → chunks[])
    On "end":
      bodyBuffer = Buffer.concat(chunks)
      if compression enabled + client accepts gzip + content-type isCompressible:
        zlib.gzip(body) → isCompressed=true, encoding="gzip"
      if upstream sent gzip: zlib.gunzip() first
      process.send(WorkerReplyMessageType)
    
  connectTimeoutTimer: setTimeout(destroyReq, connectTimeoutMs)
    → reply { errorCode:"504", error:"Connect Timeout" }
  readTimeoutTimer: setTimeout(destroyReq, readTimeoutMs)
    → reply { errorCode:"504", error:"Read Timeout" }
  proxyReq.on("error") → reply { errorCode:"502" }

  recordAndLog(status, bytes, latency):
    metricsRegistry.recordRequest(method,url,status,upstreamId,latency,tenantId)
    writeAccessLog(logPath, ip, method, url, status, bytes, latency, ua)
    if tenantDelivery.mode === "webhook":
      tenantLogStreamer.queueLog(tenantId, logEntry)`, '#1e1e1e', 12, 3880));

N.push(rect(13400, SY+55, 4140, 680, '#f3e5f5', '#7b1fa2'));
N.push(txt(13400, SY+60,
`WEBSOCKET HANDLER (src/core/proxy/websocket.handler.ts)
─────────────────────────────────────────────────────────────────────
handleWebSocketUpgrade(req, socket, head, config, lb):
  clientIP = req.headers["x-forwarded-for"]
             || req.socket.remoteAddress
  
  upstreamId = lb.pickFiltered(healthyUpstreams, clientIP)
  if null → socket.destroy() (no upstream available)
  
  upstream = config.server.upstreams.find(id)
  url = new URL(upstream.url)
  isTls = url.protocol === "wss:" || === "https:"
  
  if isTls:
    targetSocket = tls.connect({
      host: url.hostname,
      port: url.port || 443,
      rejectUnauthorized: upstream.tls?.rejectUnauthorized ?? true,
      ca: upstream.tls?.ca ? fs.readFileSync(ca) : undefined
    })
  else:
    targetSocket = net.connect({
      host: url.hostname,
      port: url.port || 80
    })
  
  targetSocket.on("connect"):
    Send HTTP upgrade handshake:
      "GET path HTTP/1.1\r\n"
      "Host: hostname\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: <from req>\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      custom headers...\r\n\r\n"
    
    socket.pipe(targetSocket)   ← client → upstream
    targetSocket.pipe(socket)   ← upstream → client
    
    Error handlers: socket.destroy() + targetSocket.destroy()
    Close handlers: same
  
  lb.incrementConnection(upstreamId)
  on disconnect: lb.releaseConnection(upstreamId)

⚠ Phase 1: WS owned by Master event loop
  10k concurrent WS = Master saturated
  Phase 2: worker.send(rawSocket) → workers own WS

CONNECTION POOL (src/core/proxy/connection.pool.ts)
─────────────────────────────────────────────────────
ConnectionPool class:
  One httpAgent per upstream (keepAlive: true)
  One httpsAgent per upstream (keepAlive: true)
  Options: { maxSockets: 50, maxFreeSockets: 10,
             timeout: 60000 }
  getAgent(upstreamId, isHttps): http.Agent | https.Agent
  Module-level instantiation (FIX#3: not per-request)

ROUTE MATCHING (src/core/router/route.matcher.ts)
───────────────────────────────────────────────────
RouteMatcher class:
  constructor(rules: RouteRule[])
  match(url: string): RouteRule | null
    → prefix match: url.startsWith(rule.path)
    → longest match wins (specific > general)

RouteRule type:
  path: string
  upstreams: string[]
  sticky: boolean
  rateLimit?: RateLimitConfig
  cache?: { enabled, ttlSeconds }
  canary?: CanaryConfig

Router class: wraps RouteMatcher, updateRules()

IPC PROTOCOL (src/core/cluster/ipc.protocol.ts)
─────────────────────────────────────────────────
WorkerMessageType (Zod schema):
  requestType: string    (HTTP method)
  headers: any
  body: string | null
  url: string
  requestId?: string     (UUID for reply matching)
  clientIp?: string

WorkerReplyMessageType (Zod schema):
  requestId?: string
  data: string           (response body)
  error?: string
  errorCode?: string     ("502"|"503"|"504")
  statusCode?: number
  isCompressed?: boolean
  encoding?: string      ("gzip")
  headers?: any          (upstream response headers)

process.send(JSON.stringify(msg)) ← bidirectional
worker.on("message", JSON.parse(raw)) ← handler`, '#1e1e1e', 12, 4120));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: TESTS, LOAD TESTS, DEPLOYMENT
// ═══════════════════════════════════════════════════════════════════════════
SY += 790;
N.push(rect(9440, SY, 8140, 500, '#fafafa', '#455a64', 3));
N.push(hdr(9460, SY+10, '🧪  TESTS + LOAD TESTS + DEPLOYMENT FILES', '#455a64', 19));

N.push(txt(9460, SY+55,
`UNIT TESTS (tests/unit/) — Jest + TypeScript
────────────────────────────────────────────────────────────────────────────────
balancer/
  loadBalancer.test.ts          → addUpstream, pickFiltered, setHealthy, stats
  loadBalancerAdvanced.test.ts  → power-of-two, adaptive-wrr, EWMA, slow start
  balancerAllStrategies.test.ts → all 12 strategies with multiple upstreams
  canarySchema.test.ts          → canary config validation (Zod schema tests)

cache/
  cache.test.ts         → L1 LRU eviction, TTL, Redis mock, buildKey
  cacheAllFeatures.test.ts → stale-while-revalidate, stale-if-error, tag invalidation

discovery/
  discovery.test.ts     → register, heartbeat timeout, deregister, persistence
  discoveryAllFeatures.test.ts → onRegister callbacks, snapshot reload

observability/
  observabilityAllFeatures.test.ts → metrics recording, histogram, tracer, readiness probe

ratelimit/
  rateLimiter.test.ts       → all 5 algorithms basic flow
  rateLimitAllAlgorithms.test.ts → edge cases, burst, window roll

resilience/
  circuitBreaker.test.ts    → CLOSED→OPEN→HALF_OPEN transitions
  resilience.test.ts        → retry with backoff, retry budget exhaustion
  resilienceAllFeatures.test.ts → bulkhead, adaptive CB, decorrelated jitter

INTEGRATION TESTS (tests/integration/) — real HTTP servers
────────────────────────────────────────────────────────────────────────────────
http-proxy.test.ts     → full proxy request/response cycle
websocket.test.ts      → WS upgrade, bidirectional messages
hot-reload.test.ts     → SIGHUP → config reload → workers restart
canary-routing.test.ts → weight-based routing, cookie stickiness
failover.test.ts       → upstream failure → retry → CB open → 503

LOAD TESTS (tests/load/k6/) — k6 JavaScript
────────────────────────────────────────────────────────────────────────────────
smoke.js     → 1 VU, baseline correctness
stress.js    → ramp to 100 VUs, find breaking point
spike.js     → sudden 200 VU spike, recovery
cache.js     → cache HIT vs MISS throughput comparison
rate-limit.js → verify 429 under high concurrency
sliding.js   → sliding window algorithm under load
sticky.js    → NINJA_ROUTE cookie persistence across requests
live-benchmark.js → realistic traffic simulation

DEPLOYMENT FILES:
────────────────────────────────────────────────────────────────────────────────
docker-compose.yml:
  services:
    proxy: pravi2005/reverse-proxy:latest
      ports: 8081:8080, 8443:8443
      extra_hosts: host.docker.internal:host-gateway
      depends_on: redis, backend-a, backend-b
      volumes: ./config.yaml, ./key.pem, ./cert.pem
    redis: redis:7-alpine, port 6379
    backend-a, backend-b: example backends

deploy/ (Kubernetes manifests):
  Deployment: ninja-reverse-proxy, replicas:1
  Service: ninja-reverse-proxy-svc (ClusterIP 8080+8443)
  ConfigMap: ninja-proxy-config (config.yaml)
  Secret: ninja-proxy-tls (cert.pem + key.pem)
  Redis Deployment + Service (same namespace)

Jenkinsfile (CI/CD pipeline):
  1. Checkout + npm install + npm run build (tsc)
  2. SonarQube scan → Quality Gate
  3. Trivy FS scan (filesystem vulnerabilities)
  4. npm test (Jest 111 tests)
  5. docker buildx build --platform linux/amd64 (multi-stage)
  6. docker push pravi2005/reverse-proxy:latest
  7. Trivy image scan (container vulnerabilities)
  8. Deploy stage: echo message (kubectl apply not automated yet)

Dockerfile (multi-stage):
  Stage 1: node:20-alpine + pnpm + tsc compile
  Stage 2: node:20-alpine + dist/ only (minimal image)

config.yaml (active config):
  listen: 8080, httpsPort: 8443, workers: 3
  loadBalancing: strategy: round-robin
  failureThreshold: 3, recoveryTimeMs: 15000
  cache: enabled: false, host: redis, port: 6379
  upstreams: [backend-a:3001, backend-b:3002]

config.canary-demo.yaml:
  Canary routing example (10% to canary upstream)

config.d/ (merge directory):
  Additional YAML files merged into main config
  Useful for environment-specific overrides`, '#1e1e1e', 12, 8100));

// ─── save ─────────────────────────────────────────────────────────────────────
diagram.elements = [...existing, ...N];
writeFileSync(file, JSON.stringify(diagram, null, 2));
console.log(`Added ${N.length} new elements`);
console.log(`Total elements: ${diagram.elements.length}`);
console.log(`File saved: ${file}`);
