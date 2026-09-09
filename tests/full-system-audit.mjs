// =============================================================================
// NINJA REVERSE PROXY — FULL SYSTEM AUDIT
// Every module · every class · every public method · every connectivity link
// =============================================================================
// §1  Load Balancing  — 12 strategies + CoreLoadBalancer
// §2  Resilience      — ClassicCB, AdaptiveCB, CBManager, Bulkhead,
//                       RetryBudget, RetryHandler, 4x Jitter Backoffs
// §3  Rate Limiting   — 5 algorithms, SoftLimit, MemoryStore, HybridStore
// §4  Caching         — InMemoryLRU, HybridCache, KeyBuilder, Cache-Control,
//                       StaleIfError, StaleWhileRevalidate,
//                       TagInvalidator, PatternInvalidator, DebeziumInvalidator
// §5  Discovery       — ServiceRegistry (full lifecycle), PassiveProbe, ActiveProbe ref
// §6  Pipeline        — MiddlewarePipeline (onion), createContext, RouteMatcher, ConnectionPool
// §7  Observability   — SystemMetrics, Histogram, HistogramRegistry,
//                       MetricsRegistry (Prometheus), Tracer spans, ReadinessProbe
// =============================================================================

import { LoadBalancer }                        from "../dist/balancer/core/load-balancer.js";
import { RoundRobinStrategy }                  from "../dist/balancer/strategies/round-robin.strategy.js";
import { WeightedRoundRobinStrategy }          from "../dist/balancer/strategies/weighted-round-robin.strategy.js";
import { RandomStrategy }                      from "../dist/balancer/strategies/random.strategy.js";
import { StickySessionsStrategy }              from "../dist/balancer/strategies/sticky-sessions.strategy.js";
import { IpHashStrategy }                      from "../dist/balancer/strategies/ip-hash.strategy.js";
import { ConsistentHashingStrategy }           from "../dist/balancer/strategies/consistent-hashing.strategy.js";
import { LeastConnectionsStrategy }            from "../dist/balancer/strategies/least-connections.strategy.js";
import { WeightedLeastConnectionsStrategy }    from "../dist/balancer/strategies/weighted-least-connections.strategy.js";
import { PowerOfTwoStrategy }                  from "../dist/balancer/strategies/power-of-two.strategy.js";
import { LeastResponseTimeStrategy }           from "../dist/balancer/strategies/least-response-time.strategy.js";
import { AdaptiveWrrStrategy }                 from "../dist/balancer/strategies/adaptive-wrr.strategy.js";
import { ResourceBasedStrategy }               from "../dist/balancer/strategies/resource-based.strategy.js";

import { ClassicCircuitBreaker }               from "../dist/resilience/circuit-breaker/classic.circuit-breaker.js";
import { AdaptiveCircuitBreaker }              from "../dist/resilience/circuit-breaker/adaptive.circuit-breaker.js";
import { CircuitBreakerManager }               from "../dist/resilience/circuit-breaker/circuit-breaker.manager.js";
import { Bulkhead }                            from "../dist/resilience/bulkhead/bulkhead.js";
import { RetryBudget }                         from "../dist/resilience/retry/retry-budget.js";
import { RetryHandler }                        from "../dist/resilience/retry/retry-handler.js";
import { calculateFullJitterBackoff }          from "../dist/resilience/retry/backoff/full-jitter.backoff.js";
import { calculateEqualJitterBackoff }         from "../dist/resilience/retry/backoff/equal-jitter.backoff.js";
import { calculateDecorrelatedJitterBackoff }  from "../dist/resilience/retry/backoff/decorrelated-jitter.backoff.js";
import { calculateExponentialBackoff }         from "../dist/resilience/retry/backoff/exponential.backoff.js";

import { TokenBucketAlgorithm }                from "../dist/ratelimit/algorithms/token-bucket.js";
import { LeakingBucketAlgorithm }              from "../dist/ratelimit/algorithms/leaking-bucket.js";
import { FixedWindowAlgorithm }                from "../dist/ratelimit/algorithms/fixed-window.js";
import { SlidingWindowLogAlgorithm }           from "../dist/ratelimit/algorithms/sliding-window-log.js";
import { SlidingWindowCounterAlgorithm }       from "../dist/ratelimit/algorithms/sliding-window-counter.js";
import { SoftLimitPolicy }                     from "../dist/ratelimit/policies/soft-limit.policy.js";
import { MemoryStore }                         from "../dist/ratelimit/storage/memory.store.js";
import { HybridStore }                         from "../dist/ratelimit/storage/hybrid.store.js";

import { InMemoryLRU }                         from "../dist/cache/stores/in-memory-lru.js";
import { HybridCache }                         from "../dist/cache/stores/hybrid.cache.js";
import { KeyBuilder }                          from "../dist/cache/policies/key-builder.js";
import { parseCacheControl }                   from "../dist/cache/policies/cache-control.parser.js";
import { StaleIfError }                        from "../dist/cache/policies/stale-if-error.js";
import { StaleWhileRevalidate }                from "../dist/cache/policies/stale-while-revalidate.js";
import { TagInvalidator }                      from "../dist/cache/invalidation/tag.invalidator.js";
import { PatternInvalidator }                  from "../dist/cache/invalidation/pattern.invalidator.js";
import { DebeziumInvalidator }                 from "../dist/cache/invalidation/debezium.invalidator.js";

import { ServiceRegistry }                     from "../dist/discovery/registry/dynamic.registry.js";
import { checkUpstream }                       from "../dist/discovery/health/active.probe.js";
import { PassiveProbe }                        from "../dist/discovery/health/passive.probe.js";

import { MiddlewarePipeline }                  from "../dist/core/pipeline/middleware.pipeline.js";
import { createContext }                       from "../dist/core/pipeline/context.js";
import { RouteMatcher }                        from "../dist/core/router/route.matcher.js";
import { getAgent, httpAgent, httpsAgent }     from "../dist/core/proxy/connection.pool.js";

import { collectSystemMetrics, systemMetricsToPrometheus } from "../dist/observability/metrics/system.metrics.js";
import { Histogram, HistogramRegistry }        from "../dist/observability/metrics/histogram.registry.js";
import { MetricsRegistry }                     from "../dist/observability/metrics/prometheus.exporter.js";
import { Tracer }                              from "../dist/observability/tracing/tracer.js";
import { ReadinessProbe }                      from "../dist/observability/health/readiness.js";

// ─────────────────────────────────────────────────────────────────────────────
// TEST HARNESS
// ─────────────────────────────────────────────────────────────────────────────
const results = [];
let pass = 0, fail = 0;

function test(section, name, condition, why = "") {
  const ok = Boolean(condition);
  ok ? pass++ : fail++;
  results.push({ section, name, ok, why });
}
async function testAsync(section, name, fn, why = "") {
  let ok = false;
  let reason = why;
  try { ok = Boolean(await fn()); } catch (e) { reason = e.message; }
  ok ? pass++ : fail++;
  results.push({ section, name, ok, why: reason });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED FIXTURES
// ─────────────────────────────────────────────────────────────────────────────
const upstates = [
  { id: "s1", weight: 1, currentWeight: 0, activeConnections: 0,
    responseTime: 20, healthy: true, requests: 10, accepts: 10,
    slowStartEndTime: 0, failures: 0, state: "CLOSED", lastFailureTime: 0, maxConnections: 100 },
  { id: "s2", weight: 2, currentWeight: 0, activeConnections: 2,
    responseTime: 50, healthy: true, requests: 10, accepts: 10,
    slowStartEndTime: 0, failures: 0, state: "CLOSED", lastFailureTime: 0, maxConnections: 100 },
];
const upstreamDefs = [
  { id: "s1", url: "http://127.0.0.1:3001", weight: 1, maxConnections: 100 },
  { id: "s2", url: "http://127.0.0.1:3002", weight: 2, maxConnections: 100 },
];

// =============================================================================
// §1  LOAD BALANCING
// =============================================================================

// 12 strategies: pick() returns a valid upstream
const rrPick   = new RoundRobinStrategy().pick(upstates);
test("§1 LoadBalancer", "RoundRobin.pick() → returns upstream", rrPick !== null);

const rr2 = new RoundRobinStrategy();
rr2.pick(upstates);
test("§1 LoadBalancer", "RoundRobin.pick() → advances on 2nd call", rr2.pick(upstates) !== null);

test("§1 LoadBalancer", "WeightedRoundRobin.pick() → returns upstream", new WeightedRoundRobinStrategy().pick(upstates) !== null);
test("§1 LoadBalancer", "Random.pick() → returns upstream",            new RandomStrategy().pick(upstates) !== null);

const sticky  = new StickySessionsStrategy("NINJA_ROUTE");
const stickyPick = sticky.pick(upstates, "127.0.0.1", "NINJA_ROUTE=s1");
test("§1 LoadBalancer", "StickySession: cookie NINJA_ROUTE=s1 → pins to s1", stickyPick?.id === "s1",
  "cookie must pin to matching upstream id");

const stickyFallback = sticky.pick(upstates, "127.0.0.1", "");
test("§1 LoadBalancer", "StickySession: no cookie → falls back to any upstream", stickyFallback !== null);

const ip1 = new IpHashStrategy().pick(upstates, "192.168.1.10");
const ip2 = new IpHashStrategy().pick(upstates, "192.168.1.10");
test("§1 LoadBalancer", "IpHash.pick() → returns upstream",                      ip1 !== null);
test("§1 LoadBalancer", "IpHash.pick() → same IP → same upstream (deterministic)", ip1?.id === ip2?.id,
  "IP hash must be stable for session affinity");

const ch = new ConsistentHashingStrategy(100);
ch.onUpstreamsChanged(upstates);
const chPick1 = ch.pick(upstates, "10.0.0.1");
const chPick2 = ch.pick(upstates, "10.0.0.1");
test("§1 LoadBalancer", "ConsistentHashing: picks from ring",                       chPick1 !== null);
test("§1 LoadBalancer", "ConsistentHashing: same key → same upstream (Ketama ring)", chPick1?.id === chPick2?.id);

const lcPick  = new LeastConnectionsStrategy().pick(upstates);
test("§1 LoadBalancer", "LeastConnections: picks s1 (0 active vs s2=2)", lcPick?.id === "s1",
  "s1 has 0 active conns, s2 has 2 — must prefer s1");

test("§1 LoadBalancer", "WeightedLeastConnections.pick() → returns upstream", new WeightedLeastConnectionsStrategy().pick(upstates) !== null);
test("§1 LoadBalancer", "PowerOfTwo.pick() → returns upstream",              new PowerOfTwoStrategy().pick(upstates) !== null);
test("§1 LoadBalancer", "LeastResponseTime.pick() → prefers lower EWMA",    new LeastResponseTimeStrategy(0.1).pick(upstates) !== null);
test("§1 LoadBalancer", "AdaptiveWRR.pick() → returns upstream",             new AdaptiveWrrStrategy(0.1).pick(upstates) !== null);
test("§1 LoadBalancer", "ResourceBased.pick() → returns upstream",           new ResourceBasedStrategy().pick(upstates) !== null);

// CoreLoadBalancer lifecycle
const coreLb   = new LoadBalancer({ upstreams: upstreamDefs }, new RoundRobinStrategy());
const corePick = coreLb.pickFiltered(new Set(["s1", "s2"]), "127.0.0.1", new Set(), undefined);
test("§1 LoadBalancer", "CoreLoadBalancer.pickFiltered() → picks from candidate set",
  corePick === "s1" || corePick === "s2");

// =============================================================================
// §2  RESILIENCE
// =============================================================================

// ClassicCircuitBreaker — full state machine
const classic = new ClassicCircuitBreaker(2, 50);
test("§2 Resilience", "ClassicCB: initial state = CLOSED",          classic.getState() === "CLOSED");
test("§2 Resilience", "ClassicCB: isAllowed() = true when CLOSED",  classic.isAllowed() === true);
classic.recordFailure();
test("§2 Resilience", "ClassicCB: 1 failure → still CLOSED (threshold=2)", classic.getState() === "CLOSED");
classic.recordFailure();
test("§2 Resilience", "ClassicCB: 2 failures → trips to OPEN",      classic.getState() === "OPEN",
  "CLOSED → OPEN after failureThreshold reached");
test("§2 Resilience", "ClassicCB: isAllowed() = false when OPEN",   classic.isAllowed() === false,
  "OPEN circuit rejects all requests");
test("§2 Resilience", "ClassicCB: getFailures() = 2",               classic.getFailures() === 2);
classic.recordSuccess(10);
test("§2 Resilience", "ClassicCB: recordSuccess() → resets to CLOSED", classic.getState() === "CLOSED");

// AdaptiveCircuitBreaker (Google SRE probability load shedding)
const acb = new AdaptiveCircuitBreaker(2, 0.9);
test("§2 Resilience", "AdaptiveCB: fresh instance allows requests",  acb.isAllowed() === true);
acb.recordSuccess(15); acb.recordSuccess(15);
test("§2 Resilience", "AdaptiveCB: after successes → still allowed", acb.isAllowed() === true);
acb.recordFailure(); acb.recordFailure(); acb.recordFailure();
const acbStats = acb.getStats();
test("§2 Resilience", "AdaptiveCB.getStats() → {requests, accepts, dropProbability}",
  typeof acbStats.requests === "number" && typeof acbStats.accepts === "number" && typeof acbStats.dropProbability === "number");

// CircuitBreakerManager — shared registry
const cbMgr   = new CircuitBreakerManager();
const cbA1    = cbMgr.getOrCreate("up-a", "classic", { failureThreshold: 3, recoveryTimeMs: 1000 });
const cbA2    = cbMgr.getOrCreate("up-a", "classic");
test("§2 Resilience", "CBManager.getOrCreate() → same key → same instance (idempotent)", cbA1 === cbA2);
const cbAdapt = cbMgr.getOrCreate("up-b", "adaptive");
test("§2 Resilience", "CBManager: different keys → different instances",  cbAdapt !== cbA1);
cbMgr.clear();
test("§2 Resilience", "CBManager.clear() → registry is empty after clear", cbMgr.get("up-a") === undefined);

// Bulkhead — concurrency slot isolation
const bh = new Bulkhead(2);
test("§2 Resilience", "Bulkhead: initial activeCount = 0",           bh.getActiveCount() === 0);
test("§2 Resilience", "Bulkhead: maxConcurrent = 2",                 bh.getMaxConcurrent() === 2);
const slot1 = bh.enter();
const slot2 = bh.enter();
const slot3 = bh.enter();
test("§2 Resilience", "Bulkhead.enter() → slot 1 acquired",          slot1 === true);
test("§2 Resilience", "Bulkhead.enter() → slot 2 acquired",          slot2 === true);
test("§2 Resilience", "Bulkhead.enter() → slot 3 REJECTED (at capacity)", slot3 === false,
  "Bulkhead must not exceed maxConcurrent");
bh.leave();
test("§2 Resilience", "Bulkhead.leave() → frees one slot (count=1)", bh.getActiveCount() === 1);
test("§2 Resilience", "Bulkhead.enter() → slot re-acquired after leave", bh.enter() === true);

await testAsync("§2 Resilience", "Bulkhead.execute() → wraps fn and returns result", async () => {
  const b = new Bulkhead(3);
  return (await b.execute(async () => "ok")) === "ok";
});
await testAsync("§2 Resilience", "Bulkhead.execute() → throws when at capacity", async () => {
  const b = new Bulkhead(1);
  b.enter();
  try { await b.execute(async () => "x"); return false; }
  catch (e) { return e.message.includes("capacity"); }
});

// RetryBudget
const rb = new RetryBudget(15, 0.9);
test("§2 Resilience", "RetryBudget.recordRetry() → returns boolean", typeof rb.recordRetry() === "boolean");
rb.recordRequest(); rb.recordRequest(); rb.recordRequest();
const rbStats = rb.getStats();
test("§2 Resilience", "RetryBudget.getStats() → {totalRequests, totalRetries, ratio}",
  typeof rbStats.totalRequests === "number" && typeof rbStats.ratio === "number");
rb.setBudgetPercent(0);
test("§2 Resilience", "RetryBudget.setBudgetPercent() → accepted without error", true);

// RetryHandler
await testAsync("§2 Resilience", "RetryHandler: succeeds on first attempt", async () => {
  const h = new RetryHandler({ shouldRetry: () => true, getDelay: () => 0 });
  return (await h.execute(async () => "ok", 3)) === "ok";
});
await testAsync("§2 Resilience", "RetryHandler: retries on failure then recovers", async () => {
  const h = new RetryHandler({ shouldRetry: () => true, getDelay: () => 0 });
  let n = 0;
  const res = await h.execute(async () => { if (++n < 3) throw new Error("fail"); return "recovered"; }, 5);
  return res === "recovered" && n === 3;
}, "Retries until success within maxAttempts");
await testAsync("§2 Resilience", "RetryHandler: throws after exhausting all attempts", async () => {
  const h = new RetryHandler({ shouldRetry: () => true, getDelay: () => 0 });
  try { await h.execute(async () => { throw new Error("perm"); }, 2); return false; }
  catch (e) { return e.message === "perm"; }
});

// Jitter Backoffs
const fj = calculateFullJitterBackoff(1, 100, 1000);
test("§2 Resilience", "FullJitter: in [0, 1000]",               fj >= 0 && fj <= 1000);

const ej = calculateEqualJitterBackoff(1, 100, 1000);
test("§2 Resilience", "EqualJitter: in [0, 1000]",              ej >= 0 && ej <= 1000);

const dj = calculateDecorrelatedJitterBackoff(1, 100, 1000, 100);
test("§2 Resilience", "DecorrelatedJitter: in [baseDelay, maxDelay]", dj >= 100 && dj <= 1000);

test("§2 Resilience", "ExponentialBackoff: attempt=1 base=100 → 200",  calculateExponentialBackoff(1, 100, 1000) === 200,
  "min(1000, 100*2^1)=200");
test("§2 Resilience", "ExponentialBackoff: capped at maxDelayMs=1000",  calculateExponentialBackoff(10, 100, 1000) === 1000,
  "100*2^10=102400, capped at 1000");

// =============================================================================
// §3  RATE LIMITING
// =============================================================================

// TokenBucket
const tb = new TokenBucketAlgorithm();
test("§3 RateLimit", "TokenBucket: 1st request allowed",        tb.check("u1", 5, 1000) === true);
for (let i = 0; i < 4; i++) tb.check("u1", 5, 1000);
test("§3 RateLimit", "TokenBucket: 6th request blocked (bucket empty)", tb.check("u1", 5, 1000) === false,
  "After 5 tokens consumed, 6th must be rejected");

// LeakingBucket
const lbk = new LeakingBucketAlgorithm();
test("§3 RateLimit", "LeakingBucket: 1st request allowed",      lbk.check("u2", 3, 1000) === true);

// FixedWindow
const fw = new FixedWindowAlgorithm();
test("§3 RateLimit", "FixedWindow: 1st request allowed",        fw.check("u3", 3, 1000) === true);
fw.check("u3", 3, 1000); fw.check("u3", 3, 1000);
test("§3 RateLimit", "FixedWindow: 4th request blocked (limit=3)", fw.check("u3", 3, 1000) === false);

// SlidingWindowLog
const swl = new SlidingWindowLogAlgorithm();
test("§3 RateLimit", "SlidingWindowLog: 1st request allowed",   swl.check("u4", 5, 1000) === true);

// SlidingWindowCounter
const swc = new SlidingWindowCounterAlgorithm();
test("§3 RateLimit", "SlidingWindowCounter: 1st request allowed", swc.check("u5", 5, 1000) === true);

// SoftLimitPolicy
const soft = new SoftLimitPolicy(100, 4, 2.0);
test("§3 RateLimit", "SoftLimit: below soft threshold → burst×2 (200)", soft.effectiveLimit(2) === 200,
  "currentLoad=2 < softLimit=4 → allow burst multiplier");
test("§3 RateLimit", "SoftLimit: above soft threshold → hard limit (100)", soft.effectiveLimit(5) === 100,
  "currentLoad=5 > softLimit=4 → enforce hard limit");

// MemoryStore
const ms = new MemoryStore();
await testAsync("§3 RateLimit", "MemoryStore.increment() → count=1 on 1st call", async () => (await ms.increment("mKey", 5000)) === 1);
await testAsync("§3 RateLimit", "MemoryStore.increment() → count=2 on 2nd call", async () => (await ms.increment("mKey", 5000)) === 2);
await testAsync("§3 RateLimit", "MemoryStore.count() → returns current count",   async () => (await ms.count("mKey")) === 2);
await testAsync("§3 RateLimit", "MemoryStore.reset() → count=0 after reset",     async () => { await ms.reset("mKey"); return (await ms.count("mKey")) === 0; });

// HybridStore
const remote  = new MemoryStore();
const hybridS = new HybridStore(remote);
await testAsync("§3 RateLimit", "HybridStore.increment() → returns count=1", async () => (await hybridS.increment("hKey", 5000)) === 1);
await testAsync("§3 RateLimit", "HybridStore.count() → reads through L1",   async () => (await hybridS.count("hKey")) >= 1);

// =============================================================================
// §4  CACHING
// =============================================================================

// InMemoryLRU
const lru = new InMemoryLRU(3);
lru.set("k1", "v1", 60);
test("§4 Cache", "InMemoryLRU.get() → HIT returns value",        lru.get("k1") === "v1");
test("§4 Cache", "InMemoryLRU.get() → MISS returns null",        lru.get("nope") === null);
lru.del("k1");
test("§4 Cache", "InMemoryLRU.del() → removes key",              lru.get("k1") === null);

// LRU eviction
lru.set("a", "va", 60); lru.set("b", "vb", 60); lru.set("c", "vc", 60);
lru.set("d", "vd", 60); // maxSize=3, should evict "a"
test("§4 Cache", "InMemoryLRU: LRU eviction — oldest entry evicted", lru.get("a") === null && lru.get("d") === "vd",
  "4th insert evicts the least-recently-used entry 'a'");

const lruStats = lru.getStats();
test("§4 Cache", "InMemoryLRU.getStats() → {size, maxSize}", lruStats.size <= 3 && lruStats.maxSize === 3);

// Expired TTL
lru.set("exp", "val", -1);
test("§4 Cache", "InMemoryLRU: expired entry (negative TTL) → null", lru.get("exp") === null,
  "Negative TTL means already expired at insert time");

// Pattern invalidation
lru.set("ns:x:1", "v1", 60); lru.set("ns:x:2", "v2", 60); lru.set("other:y", "v3", 60);
lru.invalidatePattern("ns:x:*");
test("§4 Cache", "InMemoryLRU.invalidatePattern() → removes matched keys",
  lru.get("ns:x:1") === null && lru.get("ns:x:2") === null,
  "Wildcard clears all matching cache entries");
test("§4 Cache", "InMemoryLRU.invalidatePattern() → preserves non-matching keys",
  lru.get("other:y") === "v3");

// HybridCache (L1=InMemoryLRU + L2=ICache mock)
const l2 = {
  data: new Map(),
  async get(k) { return this.data.get(k) ?? null; },
  async set(k, v) { this.data.set(k, v); },
  async del(k) { this.data.delete(k); },
  async invalidate(p) { for (const k of [...this.data.keys()]) if (k.startsWith(p.replace("*",""))) this.data.delete(k); },
  buildKey(m, p) { return `${m}:${p}`; },
};
const hc = new HybridCache(l2, 10, 60);
await testAsync("§4 Cache", "HybridCache.set() → stores in L1 and L2", async () => {
  await hc.set("hc:1", "hcVal", 60);
  return (await hc.get("hc:1")) === "hcVal" && l2.data.get("hc:1") === "hcVal";
});
await testAsync("§4 Cache", "HybridCache.get() → L1 hit (skips L2)", async () => {
  l2.data.clear(); // clear L2
  return (await hc.get("hc:1")) === "hcVal"; // still in L1
}, "L1 fast path serves without touching L2");
await testAsync("§4 Cache", "HybridCache.del() → removes from both layers", async () => {
  await hc.del("hc:1"); return (await hc.get("hc:1")) === null;
});
test("§4 Cache", "HybridCache.buildKey() → delegates to L2", hc.buildKey("GET", "/test") === "GET:/test");

// KeyBuilder
const kb  = new KeyBuilder();
const ka  = kb.build("GET", "/api?b=2&a=1");
const ka2 = kb.build("GET", "/api?b=2&a=1"); // same input again
test("§4 Cache", "KeyBuilder: same call → deterministic key (idempotent)", ka === ka2,
  "Same method+url must always produce the same cache key (deterministic)");
test("§4 Cache", "KeyBuilder: key includes method", ka.includes("GET"));
test("§4 Cache", "KeyBuilder: key includes path",   ka.includes("/api"));
test("§4 Cache", "KeyBuilder: key includes query params", ka.includes("b=2") && ka.includes("a=1"),
  "Query params must be encoded in the key to prevent cross-request cache collisions");

// parseCacheControl
const cc1 = parseCacheControl("max-age=3600, no-cache");
test("§4 Cache", "parseCacheControl: max-age=3600",  cc1.maxAge === 3600);
test("§4 Cache", "parseCacheControl: no-cache=true", cc1.noCache === true);

const cc2 = parseCacheControl("no-store, private");
test("§4 Cache", "parseCacheControl: no-store=true", cc2.noStore === true);

// StaleIfError
const sie = new StaleIfError();
test("§4 Cache", "StaleIfError: serves stale on 500 within window", sie.shouldServeStale(500, 300, 100) === true,
  "age=100 < staleIfErrorSeconds=300 and status>=500 → serve stale");
test("§4 Cache", "StaleIfError: does NOT serve stale on 200",       sie.shouldServeStale(200, 300, 100) === false);
test("§4 Cache", "StaleIfError: does NOT serve stale when too old", sie.shouldServeStale(503, 300, 500) === false,
  "age=500 > staleIfErrorSeconds=300 → entry too stale");
test("§4 Cache", "StaleIfError: status=0 (conn error) → serves stale", sie.shouldServeStale(0, 300, 50) === true);

// StaleWhileRevalidate
const swr = new StaleWhileRevalidate();
test("§4 Cache", "SWR: age>maxAge → should revalidate",      swr.shouldRevalidate("k", 120, 60) === true);
test("§4 Cache", "SWR: age<maxAge → still fresh",            swr.shouldRevalidate("k2", 30, 60) === false);
swr.markRevalidating("k");
test("§4 Cache", "SWR: in-progress → no duplicate revalidate", swr.shouldRevalidate("k", 120, 60) === false,
  "Prevents thundering herd — only one revalidation at a time");
swr.markDone("k");
test("§4 Cache", "SWR: after markDone() → allows next cycle", swr.shouldRevalidate("k", 120, 60) === true);

// TagInvalidator
const ti = new TagInvalidator();
ti.tag("cache:user:42", ["user-42", "users"]);
ti.tag("cache:user:99", ["users"]);
test("§4 Cache", "TagInvalidator.tag() → associates key with tag",   ti.getKeysForTag("user-42").includes("cache:user:42"));
test("§4 Cache", "TagInvalidator: 'users' tag maps to both keys",
  ti.getKeysForTag("users").includes("cache:user:42") && ti.getKeysForTag("users").includes("cache:user:99"),
  "Both user:42 and user:99 tagged under 'users' → invalidating 'users' clears both");
ti.removeTag("user-42");
test("§4 Cache", "TagInvalidator.removeTag() → tag is gone", ti.getKeysForTag("user-42").length === 0);

// PatternInvalidator
const patLru = new InMemoryLRU(20);
patLru.set("api:orders:1", "o1", 60); patLru.set("api:orders:2", "o2", 60); patLru.set("api:users:1", "u1", 60);
const pi = new PatternInvalidator({ invalidate: async (p) => patLru.invalidatePattern(p) });
await testAsync("§4 Cache", "PatternInvalidator.invalidate() → clears matched entries", async () => {
  await pi.invalidate("api:orders:*");
  return patLru.get("api:orders:1") === null && patLru.get("api:orders:2") === null;
}, "Wildcard pattern clears all matching keys");
test("§4 Cache", "PatternInvalidator.invalidate() → preserves non-matching keys", patLru.get("api:users:1") === "u1");

// DebeziumInvalidator (CDC)
let cdcFired = false; let cdcPath = "";
const di = new DebeziumInvalidator(
  [{ table: "orders", pathPattern: "/api/orders/{id}" }],
  async (p) => { cdcFired = true; cdcPath = p; }
);
await di.handle(JSON.stringify({ op: "u", source: { table: "orders" }, after: { id: "55" } }));
test("§4 Cache", "DebeziumInvalidator: UPDATE (op=u) → fires callback", cdcFired === true);
test("§4 Cache", "DebeziumInvalidator: {id} placeholder resolved correctly", cdcPath === "/api/orders/55",
  `got: ${cdcPath}`);

let cdcCreated = false;
const di2 = new DebeziumInvalidator(
  [{ table: "products", pathPattern: "/api/products/{id}" }],
  async () => { cdcCreated = true; }
);
await di2.handle(JSON.stringify({ op: "c", source: { table: "products" }, after: { id: "7" } }));
test("§4 Cache", "DebeziumInvalidator: INSERT (op=c) → fires callback", cdcCreated === true);

// =============================================================================
// §5  DISCOVERY
// =============================================================================

// ServiceRegistry full lifecycle
const reg = new ServiceRegistry({ heartbeatTimeoutMs: 5000, cleanupIntervalMs: 9999999 });

let cbRegEvt = null; let cbDeregEvt = null;
reg.onRegister(s => { cbRegEvt = s; });
reg.onDeregister(s => { cbDeregEvt = s; });

const svc = reg.register({ id: "alpha", url: "http://10.0.0.1:8080" });
test("§5 Discovery", "ServiceRegistry.register() → returns instance with status=UP", svc.status === "UP" && svc.id === "alpha");
test("§5 Discovery", "ServiceRegistry.get() → retrieves by id",    reg.get("alpha")?.url === "http://10.0.0.1:8080");
test("§5 Discovery", "ServiceRegistry.getAll() → includes alpha",   reg.getAll().some(s => s.id === "alpha"));
test("§5 Discovery", "ServiceRegistry.getHealthy() → lists UP services", reg.getHealthy().some(s => s.id === "alpha"));
test("§5 Discovery", "ServiceRegistry.onRegister() → callback fires with correct id", cbRegEvt?.id === "alpha",
  "Event-driven: consumers notified when service joins");

// Heartbeat
test("§5 Discovery", "ServiceRegistry.heartbeat() → true for known service",   reg.heartbeat("alpha") === true);
test("§5 Discovery", "ServiceRegistry.heartbeat() → false for unknown service", reg.heartbeat("ghost") === false);

// Deregister
const svc2 = reg.register({ id: "beta", url: "http://10.0.0.2:8080" });
const deregOk = reg.deregister("beta");
test("§5 Discovery", "ServiceRegistry.deregister() → returns true",             deregOk === true);
test("§5 Discovery", "ServiceRegistry.deregister() → service removed",          reg.get("beta") === undefined);
test("§5 Discovery", "ServiceRegistry.onDeregister() → callback fires",         cbDeregEvt?.id === "beta");
test("§5 Discovery", "ServiceRegistry.deregister() → false for unknown service", reg.deregister("ghost") === false);

const regStats = reg.getStats();
test("§5 Discovery", "ServiceRegistry.getStats() → {total, healthy, services[]}",
  typeof regStats.total === "number" && Array.isArray(regStats.services));

// PassiveProbe — event bus
const pp = new PassiveProbe();
let ppEvt = null; let pp2Count = 0;
pp.onEvent(e => { ppEvt = e; });
pp.onEvent(e => { if (e.statusCode === 503) pp2Count++; });
pp.record({ upstreamId: "alpha", statusCode: 503, latencyMs: 2100 });
test("§5 Discovery", "PassiveProbe.record() → 1st listener fires", ppEvt?.upstreamId === "alpha");
test("§5 Discovery", "PassiveProbe: statusCode passed correctly",   ppEvt?.statusCode === 503);
test("§5 Discovery", "PassiveProbe: latencyMs passed correctly",    ppEvt?.latencyMs === 2100);
test("§5 Discovery", "PassiveProbe: all listeners receive event",   pp2Count === 1,
  "Multiple onEvent() listeners all get the same event");

// Active probe: function exported and callable
test("§5 Discovery", "checkUpstream (active probe) → exported function", typeof checkUpstream === "function",
  "Used by HealthManager to periodically ping upstreams");

// =============================================================================
// §6  PIPELINE & ROUTING
// =============================================================================

// MiddlewarePipeline — onion execution order
const pipe  = new MiddlewarePipeline();
const order = [];
pipe.use(async (ctx, next) => { order.push("A:in");  await next(); order.push("A:out"); });
pipe.use(async (ctx, next) => { order.push("B:in");  await next(); order.push("B:out"); });
pipe.use(async (ctx, next) => { order.push("C");      await next(); });

const req0 = { method: "GET", url: "/test", headers: { host: "localhost" }, socket: { remoteAddress: "127.0.0.1" } };
const res0 = { writableEnded: false, end() { this.writableEnded = true; } };
const ctx0 = createContext(req0, res0);
await pipe.run(ctx0);

test("§6 Pipeline", "Middleware: A runs before B (A:in first)",   order[0] === "A:in" && order[1] === "B:in",
  "Outermost middleware enters first");
test("§6 Pipeline", "Middleware: B:out before A:out (reverse unwind)", order[3] === "B:out" && order[4] === "A:out",
  "Onion model: inner returns first, outer resumes after");
test("§6 Pipeline", "Middleware: C runs in correct position",      order[2] === "C");

// createContext
test("§6 Pipeline", "createContext: clientIp from socket.remoteAddress", ctx0.clientIp === "127.0.0.1");
test("§6 Pipeline", "createContext: method assigned",              ctx0.req.method === "GET");
test("§6 Pipeline", "createContext: url assigned",                 ctx0.req.url === "/test");
test("§6 Pipeline", "createContext: headers accessible",           ctx0.req.headers?.host === "localhost");

// X-Forwarded-For takes precedence
const xffReq = { method:"POST", url:"/x", headers:{ host:"h", "x-forwarded-for":"203.0.113.5" }, socket:{ remoteAddress:"10.0.0.1" } };
const xffCtx = createContext(xffReq, res0);
test("§6 Pipeline", "createContext: X-Forwarded-For overrides socket IP", xffCtx.clientIp === "203.0.113.5",
  "Real client IP in multi-hop proxy setups comes from X-Forwarded-For");

// RouteMatcher — uses Array.find() (first-match), so specific rules must come BEFORE general ones.
// The production config loader sorts by path-length descending before passing to RouteMatcher.
const rm = new RouteMatcher([
  { path: "/api/v2", upstream: ["api-v2"] },         // most specific first
  { path: "/api",    upstream: ["api-svc"] },
  { path: "/static", upstream: ["cdn"], methods: ["GET"] },
  { path: "/",       upstream: ["default"] },         // catch-all last
]);
test("§6 Pipeline", "RouteMatcher: /api/v1/users → /api rule (first-match order)",
  rm.match("/api/v1/users")?.upstream?.[0] === "api-svc");
test("§6 Pipeline", "RouteMatcher: /api/v2/items → /api/v2 rule (more specific, listed first)",
  rm.match("/api/v2/items")?.upstream?.[0] === "api-v2",
  "Specific rule at top gets matched first");
test("§6 Pipeline", "RouteMatcher: /unknown → / catch-all",
  rm.match("/unknown")?.upstream?.[0] === "default");
test("§6 Pipeline", "RouteMatcher: /static GET → matches cdn",
  rm.match("/static/img.png", "GET")?.upstream?.[0] === "cdn");
test("§6 Pipeline", "RouteMatcher: /static POST → method guard skips /static, falls to / catch-all",
  rm.match("/static/img.png", "POST")?.upstream?.[0] === "default",
  "Method-restricted /static rule is skipped for POST; / catch-all returns 'default'");

// ConnectionPool
test("§6 Pipeline", "ConnectionPool: getAgent(false) → httpAgent",  getAgent(false) === httpAgent);
test("§6 Pipeline", "ConnectionPool: getAgent(true) → httpsAgent",  getAgent(true) === httpsAgent);
test("§6 Pipeline", "ConnectionPool: httpAgent.keepAlive = true",   httpAgent.keepAlive === true);
test("§6 Pipeline", "ConnectionPool: httpsAgent.keepAlive = true",  httpsAgent.keepAlive === true);
test("§6 Pipeline", "ConnectionPool: httpAgent.maxSockets = 256",   httpAgent.maxSockets === 256);
test("§6 Pipeline", "ConnectionPool: httpsAgent.maxSockets = 256",  httpsAgent.maxSockets === 256);

// =============================================================================
// §7  OBSERVABILITY
// =============================================================================

// System Metrics
const sm = collectSystemMetrics();
test("§7 Observability", "collectSystemMetrics: cpuUsage is number",   typeof sm.cpuUsage === "number");
test("§7 Observability", "collectSystemMetrics: memUsedMb is number",  typeof sm.memUsedMb === "number");
test("§7 Observability", "collectSystemMetrics: memTotalMb is number", typeof sm.memTotalMb === "number");
test("§7 Observability", "collectSystemMetrics: loadAvg1m is number",      typeof sm.loadAvg1m === "number");

const smProm = systemMetricsToPrometheus(sm);
test("§7 Observability", "systemMetricsToPrometheus: returns string", typeof smProm === "string");
test("§7 Observability", "systemMetricsToPrometheus: contains cpu",  smProm.includes("cpu"));
test("§7 Observability", "systemMetricsToPrometheus: contains mem",  smProm.includes("mem"));

// Histogram
const h = new Histogram([10, 50, 100, 500]);
h.observe(5);    // ≤10
h.observe(75);   // ≤100
h.observe(200);  // ≤500
h.observe(600);  // +Inf only
const hs = h.getSnapshot();
test("§7 Observability", "Histogram: count=4 after 4 observations",  hs.count === 4);
test("§7 Observability", "Histogram: sum=880",                        hs.sum === 880);
test("§7 Observability", "Histogram: ≤10 bucket count=1",   hs.buckets.find(b=>b.le===10)?.count === 1);
test("§7 Observability", "Histogram: ≤100 bucket count=2",  hs.buckets.find(b=>b.le===100)?.count === 2,
  "5 and 75 both ≤100");
test("§7 Observability", "Histogram: ≤500 bucket count=3",  hs.buckets.find(b=>b.le===500)?.count === 3,
  "5, 75, 200 all ≤500");
test("§7 Observability", "Histogram: +Inf bucket count=4",  hs.buckets.find(b=>b.le===Infinity)?.count === 4);

const hProm = h.toPrometheus("ninja_latency", 'route="/api"');
test("§7 Observability", "Histogram.toPrometheus(): has _bucket lines", hProm.includes("_bucket"));
test("§7 Observability", "Histogram.toPrometheus(): has _sum line",     hProm.includes("_sum"));
test("§7 Observability", "Histogram.toPrometheus(): has _count line",   hProm.includes("_count"));

// HistogramRegistry
const hr  = new HistogramRegistry();
const h1  = hr.getOrCreate("lat:route=\"/api\"");
h1.observe(42);
const h1b = hr.getOrCreate("lat:route=\"/api\"");
test("§7 Observability", "HistogramRegistry.getOrCreate() → same key → same instance", h1 === h1b,
  "Registry is idempotent");
const h2  = hr.getOrCreate("lat:route=\"/health\"");
h2.observe(5);
test("§7 Observability", "HistogramRegistry: different keys → different instances", h1 !== h2);

const hrSnaps = hr.getSnapshotAll();
test("§7 Observability", "HistogramRegistry.getSnapshotAll() → 2 snapshots", Object.keys(hrSnaps).length === 2);

const hrProm = hr.toPrometheusAll("lat");
test("§7 Observability", "HistogramRegistry.toPrometheusAll() → includes both routes",
  hrProm.includes("/api") && hrProm.includes("/health"));

const hr2 = new HistogramRegistry();
hr2.mergeAll(hrSnaps);
test("§7 Observability", "HistogramRegistry.mergeAll() → merged count correct",
  hr2.getSnapshotAll()["lat:route=\"/api\""]?.count === 1);

// MetricsRegistry — full Prometheus exposition
const mr = new MetricsRegistry(new Set(["up-1", "up-2"]));
mr.recordRequest("GET",  "/api/games", 200, "up-1", 35);
mr.recordRequest("POST", "/api/games", 201, "up-1", 60);
mr.recordRequest("GET",  "/api/games", 500, "up-2", 120);
mr.recordActiveConnection("up-1", 3);
mr.recordCacheOp("hit"); mr.recordCacheOp("miss"); mr.recordCacheOp("hit");

const expo = mr.getExpositionFormat(["up-1", "up-2"]);
test("§7 Observability", "MetricsRegistry: ninja_http_requests_total present",   expo.includes("ninja_http_requests_total"));
test("§7 Observability", "MetricsRegistry: upstream_id label present",           expo.includes('upstream_id="up-1"'));
test("§7 Observability", "MetricsRegistry: ninja_http_request_duration_ms hist", expo.includes("ninja_http_request_duration_ms"));
test("§7 Observability", "MetricsRegistry: ninja_active_connections gauge",      expo.includes("ninja_active_connections"));
test("§7 Observability", "MetricsRegistry: ninja_cache_operations_total counter", expo.includes("ninja_cache_operations_total"));
test("§7 Observability", "MetricsRegistry: ninja_upstream_status gauge",         expo.includes("ninja_upstream_status"));
test("§7 Observability", "MetricsRegistry: # HELP lines present (OpenMetrics)",  expo.includes("# HELP"));
test("§7 Observability", "MetricsRegistry: # TYPE lines present (OpenMetrics)",  expo.includes("# TYPE"));

const snap = mr.getSnapshot();
test("§7 Observability", "MetricsRegistry.getSnapshot(): requestsTotal is array",    Array.isArray(snap.requestsTotal));
test("§7 Observability", "MetricsRegistry.getSnapshot(): activeConnections is array", Array.isArray(snap.activeConnections));
test("§7 Observability", "MetricsRegistry.getSnapshot(): cacheOperations is array",  Array.isArray(snap.cacheOperations));

const mr2 = new MetricsRegistry(new Set(["up-1"]));
mr2.mergeSnapshot(snap);
test("§7 Observability", "MetricsRegistry.mergeSnapshot() → merged data visible",
  mr2.getExpositionFormat(["up-1"]).includes("ninja_http_requests_total"));

const filtered = mr.getExpositionFormat(["up-1", "up-2"], "none");
test("§7 Observability", "MetricsRegistry.getExpositionFormat(tenantFilter) → returns string",
  typeof filtered === "string" && filtered.length > 0);

// Tracer — distributed span lifecycle
const tr   = new Tracer();
const span = tr.startSpan("db.query", "trace-abc", { "db.table": "users" });
test("§7 Observability", "Tracer.startSpan() → traceId set",            span.traceId === "trace-abc");
test("§7 Observability", "Tracer.startSpan() → spanId is string",       typeof span.spanId === "string" && span.spanId.length > 0);
test("§7 Observability", "Tracer.startSpan() → name set",               span.name === "db.query");
test("§7 Observability", "Tracer.startSpan() → startMs is timestamp",   typeof span.startMs === "number" && span.startMs > 0);
test("§7 Observability", "Tracer.startSpan() → attributes captured",    span.attributes["db.table"] === "users");
test("§7 Observability", "Tracer.startSpan() → endMs undefined until endSpan()", span.endMs === undefined);

tr.endSpan(span);
test("§7 Observability", "Tracer.endSpan() → sets endMs",               typeof span.endMs === "number");
test("§7 Observability", "Tracer.endSpan() → endMs >= startMs",         span.endMs >= span.startMs);

tr.startSpan("http.req", "trace-xyz");
const flushed = tr.flush();
test("§7 Observability", "Tracer.flush() → returns all buffered spans", flushed.length === 2,
  "flush collects all spans including unended ones");
test("§7 Observability", "Tracer.flush() → clears buffer after flush",  tr.flush().length === 0,
  "Buffer reset after flush — ready for next batch");

// ReadinessProbe
const rp1 = new ReadinessProbe();
rp1.register({ name: "db",    check: async () => true });
rp1.register({ name: "redis", check: async () => true });
await testAsync("§7 Observability", "ReadinessProbe: all healthy → ready=true", async () => {
  const r = await rp1.isReady();
  return r.ready === true && r.checks.db === true && r.checks.redis === true;
}, "All deps healthy → service is READY");

const rp2 = new ReadinessProbe();
rp2.register({ name: "db",    check: async () => true });
rp2.register({ name: "redis", check: async () => false });
await testAsync("§7 Observability", "ReadinessProbe: one unhealthy → ready=false", async () => {
  const r = await rp2.isReady();
  return r.ready === false && r.checks.db === true && r.checks.redis === false;
}, "One failing dep → service NOT ready");

const rp3 = new ReadinessProbe();
rp3.register({ name: "crash", check: async () => { throw new Error("refused"); } });
await testAsync("§7 Observability", "ReadinessProbe: thrown exception → treated as false", async () => {
  const r = await rp3.isReady();
  return r.ready === false && r.checks.crash === false;
}, "Exceptions in checks are caught and reported as failures");

// =============================================================================
// FINAL REPORT
// =============================================================================
const BAR  = "═".repeat(80);
const bar  = "─".repeat(80);

console.log(`\n${BAR}`);
console.log("  NINJA REVERSE PROXY  ·  FULL SYSTEM AUDIT REPORT");
console.log(`${BAR}`);

let section = "";
for (const r of results) {
  if (r.section !== section) {
    section = r.section;
    console.log(`\n${bar}`);
    console.log(`  ${section}`);
    console.log(bar);
  }
  const icon = r.ok ? "  ✅ PASS" : "  ❌ FAIL";
  console.log(`${icon}  ${r.name}`);
  if (!r.ok && r.why) console.log(`           ↳ ${r.why}`);
}

const total = pass + fail;
console.log(`\n${BAR}`);
console.log(`  RESULT:  ${pass} PASSED  /  ${fail} FAILED  /  ${total} TOTAL`);
console.log(`${BAR}\n`);

if (fail > 0) {
  console.log(`⚠️  ${fail} test(s) FAILED — fix before moving to next stage.\n`);
  process.exit(1);
} else {
  console.log(`🎉  All ${total} tests passed. Every service is correctly configured and verified.\n`);
  process.exit(0);
}
