import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import zlib from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "redis";
import type { RedisClientType } from "redis";
import { performance } from "node:perf_hooks";

import { rootConfigSchema } from "../../config/schemas/server.schema.js";
import { logger, writeAccessLog } from "../../observability/logger/logger.js";
import { tenantLogStreamer } from "../../observability/logger/tenant-log.streamer.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { readinessProbe } from "../../observability/health/readiness.js";
import { passiveProbe } from "../../discovery/health/passive.probe.js";
import { registerPassiveProbeListener } from "../../discovery/health/health.manager.js";
import { RateLimiter } from "../../ratelimit/rate-limiter.js";
import { LoadBalancer, createLoadBalancer } from "../../balancer/index.js";
import { Cache } from "../../cache/cache-manager.js";
import { globalRetryBudget } from "../../resilience/retry/retry-budget.js";
import { Bulkhead } from "../../resilience/bulkhead/bulkhead.js";
import { calculateExponentialBackoff } from "../../resilience/retry/backoff/exponential.backoff.js";
import { calculateFullJitterBackoff } from "../../resilience/retry/backoff/full-jitter.backoff.js";
import { calculateEqualJitterBackoff } from "../../resilience/retry/backoff/equal-jitter.backoff.js";
import { calculateDecorrelatedJitterBackoff } from "../../resilience/retry/backoff/decorrelated-jitter.backoff.js";
import { isMethodRetrySafe } from "../../resilience/retry/idempotency.js";
import { handleAdminRequest, type RegistryClient } from "../admin/admin.handler.js";
import type { ServiceInstance } from "../../discovery/registry/dynamic.registry.js";
import { MiddlewarePipeline } from "../pipeline/middleware.pipeline.js";
import { createContext, resolveClientIp } from "../pipeline/context.js";
import { corsMiddleware } from "../../middleware/cors.middleware.js";
import { tracingMiddleware } from "../../middleware/tracing.middleware.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { RouteMatcher } from "../router/route.matcher.js";
import type { RouteRule } from "../router/route.types.js";
import { tunnelWebSocket } from "../proxy/websocket.handler.js";
import { getAgent } from "../proxy/connection.pool.js";
import type { RootConfigType } from "../../config/schemas/server.schema.js";

// =============================================================================
//  WORKER — owns the entire datapath (Phase B)
// =============================================================================
//  Each worker listens on the same port as every sibling worker; Node's
//  cluster module shares the listening socket and balances accepted
//  connections across them. From there, this file is the whole proxy for
//  that connection: routing, CORS, tracing, auth, rate limiting, caching,
//  load balancing, circuit breaking, retries, and upstream proxying (bodies
//  piped with stream.pipeline in both directions, so backpressure is native
//  — no IPC carries request/response bytes).
//
//  IPC to master is control-plane only: registry mutation forwarding,
//  registry/health broadcast, metrics aggregation, and (for in-memory,
//  non-Redis rate limiting only) batched token leasing.
// =============================================================================

let workerConfig: RootConfigType;
try {
  const rawAppConfig = JSON.parse(process.env["APP_CONFIG"]!);
  workerConfig = await rootConfigSchema.parseAsync(rawAppConfig);
} catch (err: any) {
  logger.error(`Worker:${process.pid}`, `Fatal: invalid APP_CONFIG at startup — ${err.message}`);
  process.exit(1);
}

function getEffectiveCache(config: RootConfigType) {
  return config.cache ?? config.server.cache;
}
function getEffectiveRateLimit(config: RootConfigType) {
  return config.rateLimit ?? config.server.rateLimit;
}
function getEffectiveResilience(config: RootConfigType) {
  return config.resilience ?? config.server.resilience;
}

const MAX_REQUEST_BODY_BYTES_DEFAULT = workerConfig.server.maxRequestBodyBytes ?? 10 * 1024 * 1024;
const RETRY_BUFFER_LIMIT_BYTES_DEFAULT = workerConfig.server.retryBufferLimitBytes ?? 1 * 1024 * 1024;
const maxResponseBytes = workerConfig.server.maxResponseBytes ?? 25 * 1024 * 1024;

const routeMatcher = new RouteMatcher(workerConfig.server.paths as RouteRule[]);
const metricsRegistry = new MetricsRegistry(new Set(workerConfig.server.upstreams.map((u) => u.id)));
const HEALTHY_UPSTREAMS = new Set<string>(workerConfig.server.upstreams.map((u) => u.id));
const registryMirror = new Map<string, ServiceInstance>(
  workerConfig.server.upstreams.map((u) => [
    u.id,
    { id: u.id, url: u.url, registeredAt: Date.now(), lastHeartbeat: Date.now(), status: "UP" as const },
  ]),
);
const upstreamBulkheads = new Map<string, Bulkhead>();

globalRetryBudget.setBudgetPercent(workerConfig.server.resilience?.retry?.budgetPercent ?? 15);

let lb: LoadBalancer = createLoadBalancer({
  strategy: workerConfig.server.loadBalancing.strategy,
  upstreams: workerConfig.server.upstreams,
  virtualNodes: workerConfig.server.loadBalancing.virtualNodes,
  ewmaAlpha: workerConfig.server.loadBalancing.ewmaAlpha,
  stickyCookieName: workerConfig.server.loadBalancing.stickyCookieName,
  slowStartSeconds: workerConfig.server.loadBalancing.slowStartSeconds,
  circuitBreaker: workerConfig.server.resilience?.circuitBreaker,
});
for (const id of HEALTHY_UPSTREAMS) lb.setHealthy(id, true);
registerPassiveProbeListener(HEALTHY_UPSTREAMS, lb);

const effectiveCache = getEffectiveCache(workerConfig);
const cache = new Cache({
  enabled: effectiveCache.enabled,
  host: effectiveCache.host,
  port: effectiveCache.port,
  ttlSeconds: effectiveCache.ttlSeconds,
  l1Enabled: effectiveCache.l1Enabled,
  l1MaxSize: effectiveCache.l1MaxSize,
  staleWhileRevalidate: effectiveCache.staleWhileRevalidate,
  staleIfError: effectiveCache.staleIfError,
  staleIfErrorSeconds: effectiveCache.staleIfErrorSeconds,
  key: effectiveCache.key,
  debezium: effectiveCache.debezium,
});
await cache.connect().catch(() => {});

if (workerConfig.observability?.tenantDelivery?.mode === "webhook") {
  tenantLogStreamer.configure(workerConfig.observability.tenantDelivery.exportEndpoints);
}

readinessProbe.register({ name: "upstream-available", check: async () => HEALTHY_UPSTREAMS.size > 0 });
readinessProbe.register({
  name: "cache-connected",
  check: async () => {
    try {
      return cache.isConnected?.() ?? true;
    } catch {
      return false;
    }
  },
});

// -----------------------------------------------------------------------------
// Rate limiting: Redis/hybrid-storage limiters are real RateLimiter instances
// here, talking to Redis directly (already cluster-safe — no master involved).
// In-memory-storage limiters instead lease batches of permits from master's
// canonical instance (see leaseTokens below) — see Phase C design note at top
// of master.ts's handleRlLeaseRequest.
// -----------------------------------------------------------------------------
let rlRedisClient: RedisClientType | undefined;
const redisRateLimiters = new Map<string, RateLimiter>();
const memoryLimiterConfigs = new Map<
  string,
  { windowMs: number; maxRequests: number; algorithm: string }
>();

function isRedisStorage(storage: string | undefined): boolean {
  return storage === "redis" || storage === "hybrid";
}

async function setupRateLimiting(config: RootConfigType) {
  redisRateLimiters.clear();
  memoryLimiterConfigs.clear();
  const effectiveRateLimit = getEffectiveRateLimit(config);
  const needsRedis =
    isRedisStorage(effectiveRateLimit?.storage) ||
    config.server.paths.some((p: any) => isRedisStorage(p.rateLimit?.storage));
  if (needsRedis && !rlRedisClient) {
    const redisHost = effectiveRateLimit?.redis?.host ?? config.server.cache?.host ?? "127.0.0.1";
    const redisPort = effectiveRateLimit?.redis?.port ?? config.server.cache?.port ?? 6379;
    rlRedisClient = createClient({ socket: { host: redisHost, port: redisPort } }) as RedisClientType;
    rlRedisClient.on("error", (err) => logger.error("RateLimiterRedis", err.message));
    await rlRedisClient.connect().catch((err) => logger.error("RateLimiterRedis", `Connection failed: ${err.message}`));
  }
  if (effectiveRateLimit && effectiveRateLimit.enabled !== false) {
    if (isRedisStorage(effectiveRateLimit.storage)) {
      redisRateLimiters.set(
        "global",
        new RateLimiter({
          windowMs: effectiveRateLimit.windowMs,
          maxRequests: effectiveRateLimit.maxRequests,
          algorithm: effectiveRateLimit.algorithm,
          storage: effectiveRateLimit.storage,
          redisClient: rlRedisClient,
          softLimit: effectiveRateLimit.softLimit,
          burstMultiplier: effectiveRateLimit.burstMultiplier,
        }),
      );
    } else {
      memoryLimiterConfigs.set("global", {
        windowMs: effectiveRateLimit.windowMs,
        maxRequests: effectiveRateLimit.maxRequests,
        algorithm: effectiveRateLimit.algorithm,
      });
    }
  }
  config.server.paths.forEach((p: any) => {
    if (!p.rateLimit) return;
    if (isRedisStorage(p.rateLimit.storage)) {
      redisRateLimiters.set(
        `route:${p.path}`,
        new RateLimiter({
          windowMs: p.rateLimit.windowMs,
          maxRequests: p.rateLimit.maxRequests,
          algorithm: p.rateLimit.algorithm,
          storage: p.rateLimit.storage,
          redisClient: rlRedisClient,
        }),
      );
    } else {
      memoryLimiterConfigs.set(`route:${p.path}`, {
        windowMs: p.rateLimit.windowMs,
        maxRequests: p.rateLimit.maxRequests,
        algorithm: p.rateLimit.algorithm,
      });
    }
  });
}
await setupRateLimiting(workerConfig);
// Precomputed so the hot path can skip the async checkRateLimit() round-trip entirely for a
// scope that was never configured, instead of awaiting a call that always resolves to
// "not limited" anyway.
const globalRateLimitConfigured = redisRateLimiters.has("global") || memoryLimiterConfigs.has("global");
function routeRateLimitConfigured(path: string): boolean {
  return redisRateLimiters.has(`route:${path}`) || memoryLimiterConfigs.has(`route:${path}`);
}

interface LeaseBucket {
  remaining: number;
  resetAt: number;
  algorithm: string;
  algoState?: any;
}
const leaseBuckets = new Map<string, LeaseBucket>();
const inFlightLeases = new Map<string, Promise<LeaseBucket>>();
const pendingLeaseRequests = new Map<string, (bucket: LeaseBucket) => void>();

function requestLease(scope: string, key: string, cfg: { windowMs: number; maxRequests: number; algorithm: string }): Promise<LeaseBucket> {
  const mapKey = `${scope}:${key}`;
  const existing = inFlightLeases.get(mapKey);
  if (existing) return existing;
  const p = new Promise<LeaseBucket>((resolve) => {
    const requestId = `${process.pid}-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      pendingLeaseRequests.delete(requestId);
      resolve({ remaining: 0, resetAt: Date.now() + cfg.windowMs, algorithm: cfg.algorithm });
    }, 3000);
    pendingLeaseRequests.set(requestId, (bucket) => {
      clearTimeout(timer);
      resolve(bucket);
    });
    safeProcessSend(
      JSON.stringify({
        type: "RL_LEASE_REQUEST",
        requestId,
        scope,
        key,
        windowMs: cfg.windowMs,
        maxRequests: cfg.maxRequests,
        algorithm: cfg.algorithm,
      }),
    );
  }).finally(() => inFlightLeases.delete(mapKey));
  inFlightLeases.set(mapKey, p);
  return p;
}

/** Checks (and consumes) one in-memory-storage rate-limit permit for (scope,key). */
async function checkMemoryLeasedLimit(
  scope: string,
  key: string,
  cfg: { windowMs: number; maxRequests: number; algorithm: string },
): Promise<{ allowed: boolean; resetAt: number; algorithm: string; algoState?: any }> {
  const mapKey = `${scope}:${key}`;
  let bucket = leaseBuckets.get(mapKey);
  const now = Date.now();
  if (!bucket || now >= bucket.resetAt || bucket.remaining <= 0) {
    bucket = await requestLease(scope, key, cfg);
    leaseBuckets.set(mapKey, bucket);
  }
  if (bucket.remaining > 0) {
    bucket.remaining--;
    return { allowed: true, resetAt: bucket.resetAt, algorithm: bucket.algorithm, algoState: bucket.algoState };
  }
  return { allowed: false, resetAt: bucket.resetAt, algorithm: bucket.algorithm, algoState: bucket.algoState };
}

async function checkRateLimit(
  scope: string,
  key: string,
): Promise<{ limited: boolean; allowed: boolean; resetAt: number; algorithm: string; algoState?: any }> {
  const redisLimiter = redisRateLimiters.get(scope);
  if (redisLimiter) {
    const allowed = await redisLimiter.isAllowed(key);
    const algoState = await redisLimiter.getAlgorithmState(key);
    return { limited: true, allowed, resetAt: redisLimiter.getResetTime(key), algorithm: redisLimiter.getAlgorithm(), algoState };
  }
  const memCfg = memoryLimiterConfigs.get(scope);
  if (memCfg) {
    const result = await checkMemoryLeasedLimit(scope, key, memCfg);
    return { limited: true, ...result };
  }
  return { limited: false, allowed: true, resetAt: 0, algorithm: "" };
}

// -----------------------------------------------------------------------------
// Registry mirror + mutation forwarding (master owns the canonical registry).
// -----------------------------------------------------------------------------
const pendingRegistryMutations = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();

function registryMutate(action: "register" | "deregister" | "heartbeat", payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = `${process.pid}-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      pendingRegistryMutations.delete(requestId);
      reject(new Error("Registry mutation timed out"));
    }, 5000);
    pendingRegistryMutations.set(requestId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    safeProcessSend(JSON.stringify({ type: "REGISTRY_MUTATE", requestId, action, payload }));
  });
}

const registryClient: RegistryClient = {
  register: (instance) => registryMutate("register", instance),
  deregister: (id) => registryMutate("deregister", { id }),
  heartbeat: (id) => registryMutate("heartbeat", { id }),
  getAll: () => [...registryMirror.values()],
  get: (id) => registryMirror.get(id),
  getStats: () => {
    const all = [...registryMirror.values()];
    return {
      total: all.length,
      healthy: all.filter((s) => s.status === "UP").length,
      services: all.map((s) => ({
        id: s.id,
        url: s.url,
        status: s.status,
        uptime: `${Math.floor((Date.now() - s.registeredAt) / 1000)}s`,
        lastHeartbeat: `${Math.floor((Date.now() - s.lastHeartbeat) / 1000)}s ago`,
        metadata: s.metadata,
      })),
    };
  },
};

// -----------------------------------------------------------------------------
// Metrics aggregation (master fans DUMP_METRICS_REQUEST out to every other
// worker and hands the results back here; our own snapshot is added locally).
// -----------------------------------------------------------------------------
const pendingMetricsAggregates = new Map<string, (snapshots: any[]) => void>();

function requestMetricsAggregate(): Promise<any[]> {
  return new Promise((resolve) => {
    const requestId = `${process.pid}-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      pendingMetricsAggregates.delete(requestId);
      resolve([]);
    }, 2000);
    pendingMetricsAggregates.set(requestId, (snapshots) => {
      clearTimeout(timer);
      resolve(snapshots);
    });
    safeProcessSend(JSON.stringify({ type: "METRICS_AGGREGATE_REQUEST", requestId }));
  });
}

async function collectWorkerMetricSnapshots(): Promise<any[]> {
  const others = await requestMetricsAggregate();
  return [metricsRegistry.getSnapshot(), ...others];
}

// -----------------------------------------------------------------------------
// CDC invalidation broadcast: this worker has already run the Debezium event through its own
// cache.handleDebeziumEvent() (purging its own L1 and the shared L2/Redis entry) before
// calling this — every OTHER worker's own L1 copy is otherwise invisible from here and never
// gets purged, since each worker's HybridCache keeps a separate in-process LRU. Master fans
// the same event out to every other worker and sums their reported counts with ours.
// -----------------------------------------------------------------------------
const pendingCdcInvalidateBroadcasts = new Map<string, (count: number) => void>();

function requestCdcInvalidateBroadcast(eventJson: string): Promise<number> {
  return new Promise((resolve) => {
    const requestId = `${process.pid}-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      pendingCdcInvalidateBroadcasts.delete(requestId);
      resolve(0);
    }, 3000);
    pendingCdcInvalidateBroadcasts.set(requestId, (count) => {
      clearTimeout(timer);
      resolve(count);
    });
    safeProcessSend(JSON.stringify({ type: "CDC_INVALIDATE_BROADCAST_REQUEST", requestId, eventJson }));
  });
}

// -----------------------------------------------------------------------------
// Lifecycle: graceful shutdown drains in-flight requests before this process
// exits; IPC send backpressure is handled the same way master.ts always has.
// -----------------------------------------------------------------------------
let draining = false;
let activeRequestCount = 0;
let httpServer: http.Server | undefined;
let httpsServer: https.Server | undefined;

function maybeExitWhenDrained() {
  if (draining && activeRequestCount === 0) {
    logger.info(`Worker:${process.pid}`, "Drain complete — exiting");
    void logger.flushAll().finally(() => process.exit(0));
  }
}

function safeProcessSend(msg: string): void {
  if (!process.send) return;
  try {
    process.send(msg);
  } catch {}
}

process.on("message", (rawMsg: any) => {
  try {
    const parsed = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
    if (!parsed) return;

    if (parsed.type === "UPDATE_SERVICES") {
      const incomingIds = new Set<string>();
      if (Array.isArray(parsed.registry)) {
        for (const svc of parsed.registry as ServiceInstance[]) {
          incomingIds.add(svc.id);
          registryMirror.set(svc.id, svc);
          lb.addUpstream(svc.id, svc.url); // no-op if already known — see LoadBalancer.addUpstream
        }
      }
      for (const id of [...registryMirror.keys()]) {
        if (!incomingIds.has(id)) {
          registryMirror.delete(id);
          lb.removeUpstream(id);
        }
      }
      HEALTHY_UPSTREAMS.clear();
      if (Array.isArray(parsed.healthyUpstreams)) {
        for (const id of parsed.healthyUpstreams) {
          HEALTHY_UPSTREAMS.add(id);
          lb.setHealthy(id, true);
        }
      }
      for (const id of incomingIds) {
        if (!HEALTHY_UPSTREAMS.has(id)) lb.setHealthy(id, false);
      }
      return;
    }

    if (parsed.type === "GRACEFUL_SHUTDOWN") {
      logger.info(`Worker:${process.pid}`, `Gracefully draining connections (${activeRequestCount} in flight)`);
      draining = true;
      if (httpServer) httpServer.close();
      if (httpsServer) httpsServer.close();
      maybeExitWhenDrained();
      return;
    }

    if (parsed.type === "DUMP_METRICS_REQUEST") {
      safeProcessSend(JSON.stringify({ type: "DUMP_METRICS_RESPONSE", requestId: parsed.requestId, data: metricsRegistry.getSnapshot() }));
      return;
    }

    if (parsed.type === "METRICS_AGGREGATE_RESPONSE") {
      const resolve = pendingMetricsAggregates.get(parsed.requestId);
      if (resolve) {
        pendingMetricsAggregates.delete(parsed.requestId);
        resolve(parsed.snapshots ?? []);
      }
      return;
    }

    if (parsed.type === "CDC_INVALIDATE_L1_REQUEST") {
      void cache.handleDebeziumEvent(parsed.eventJson).then((count) => {
        safeProcessSend(JSON.stringify({ type: "CDC_INVALIDATE_L1_RESPONSE", requestId: parsed.requestId, count }));
      });
      return;
    }

    if (parsed.type === "CDC_INVALIDATE_BROADCAST_RESPONSE") {
      const resolve = pendingCdcInvalidateBroadcasts.get(parsed.requestId);
      if (resolve) {
        pendingCdcInvalidateBroadcasts.delete(parsed.requestId);
        resolve(parsed.count ?? 0);
      }
      return;
    }

    if (parsed.type === "REGISTRY_MUTATE_RESPONSE") {
      const pending = pendingRegistryMutations.get(parsed.requestId);
      if (pending) {
        pendingRegistryMutations.delete(parsed.requestId);
        if (parsed.error) pending.reject(new Error(parsed.error));
        else pending.resolve(parsed.result);
      }
      return;
    }

    if (parsed.type === "RL_LEASE_RESPONSE") {
      const resolve = pendingLeaseRequests.get(parsed.requestId);
      if (resolve) {
        pendingLeaseRequests.delete(parsed.requestId);
        resolve({ remaining: parsed.granted, resetAt: parsed.resetAt, algorithm: parsed.algorithm, algoState: parsed.algoState });
      }
      return;
    }
  } catch (err: any) {
    logger.error(`Worker:${process.pid}`, `Error processing master message: ${err.message}`);
  }
});

// -----------------------------------------------------------------------------
// Small helpers ported from the old master.ts (canary/sticky/cookies/stale).
// -----------------------------------------------------------------------------
function isIpAllowed(clientIp: string, allowedIps?: string[]): boolean {
  if (!allowedIps || allowedIps.length === 0) return true;
  const normalizedClient = clientIp.replace(/^::ffff:/, "").trim();
  return allowedIps.some((allowed) => {
    const normAllowed = allowed.replace(/^::ffff:/, "").trim();
    return (
      normAllowed === normalizedClient ||
      (normalizedClient === "::1" && normAllowed === "127.0.0.1") ||
      (normalizedClient === "127.0.0.1" && normAllowed === "::1")
    );
  });
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    if (parts[0]) {
      list[parts[0].trim()] = parts.slice(1).join("=").trim();
    }
  });
  return list;
}

function createNoopResponse(): http.ServerResponse {
  // A real Writable (not a plain object with matching method names): performUpstreamCall
  // pipes the upstream response straight into this when success-ish (source.pipe(res)), and
  // Readable.pipe() calls dest.emit(...) internally — a plain object fails with "dest.emit is
  // not a function" and takes the whole worker down via uncaughtException. Writable supplies
  // real EventEmitter behavior (close/finish/error) for free, matching what handleProxyDispatch
  // expects from res.on(...) here, since nobody is actually listening for this background
  // stale-while-revalidate response.
  const w = new Writable({
    write(_chunk, _enc, callback) {
      callback();
    },
  });
  (w as unknown as { writeHead: () => void }).writeHead = () => {};
  return w as unknown as http.ServerResponse;
}

async function tryServeStaleOnError(
  payload: { requestType: string; url: string; headers: any },
  pathRule: RouteRule | undefined,
  errorStatus: number,
  res: http.ServerResponse,
): Promise<boolean> {
  const isCacheMethod = payload.requestType === "GET" || payload.requestType === "HEAD";
  if (!isCacheMethod || pathRule?.cache?.enabled === false) return false;
  try {
    const parsedUrl = new URL(payload.url, "http://dummy");
    const cacheKey = cache.buildKey(payload.requestType, parsedUrl.pathname + parsedUrl.search, payload.headers);
    const cachedJson = await cache.get(cacheKey);
    if (!cachedJson) return false;
    const cached = JSON.parse(cachedJson);
    const ageSeconds = cached.storedAt ? (Date.now() - cached.storedAt) / 1000 : Infinity;
    if (!cache.shouldServeStaleOnError(errorStatus, ageSeconds)) return false;
    const bodyBuf = Buffer.from(cached.body, "base64");
    res.writeHead(cached.statusCode ?? 200, { ...(cached.headers || {}), "X-Cache": "STALE-ON-ERROR" });
    res.end(payload.requestType === "HEAD" ? undefined : bodyBuf);
    logger.warn("Cache", `Served stale response in place of upstream error (status=${errorStatus})`, { cacheKey });
    return true;
  } catch {
    return false;
  }
}

/** A byte-counting passthrough Transform that errors once `maxBytes` is exceeded — used for
 *  both the request-body and response-body caps, enforced while streaming (native
 *  backpressure throughout; nothing is ever buffered whole just to check its size). */
function createByteLimitGuard(maxBytes: number, onChunk?: (buf: Buffer) => void, initialBytes = 0): Transform {
  let received = initialBytes;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new Error("BYTE_LIMIT_EXCEEDED"));
        return;
      }
      onChunk?.(chunk);
      callback(null, chunk);
    },
  });
}

/** A passthrough Transform that also hands every chunk to `onChunk` — used to build a cache
 *  entry out of exactly the bytes actually sent to the client, without buffering twice. */
function createTeeTransform(onChunk: (buf: Buffer) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      onChunk(chunk);
      callback(null, chunk);
    },
  });
}

interface SelectedUpstream {
  upstreamId: string;
  routeStage: string | undefined;
  setCanaryCookieVal: string | undefined;
}

/** Shared by the HTTP dispatch path and the WebSocket upgrade path: canary split, sticky
 *  session pin, then load-balancer pick over the route's (or global) healthy candidate set. */
function selectUpstream(
  pathRule: RouteRule | undefined,
  headers: Record<string, any>,
  clientIp: string,
  attemptedUpstreams: Set<string>,
): SelectedUpstream | null {
  const allowedUpstreams = pathRule?.upstream ?? [];
  const routeHealthyUpstreams = new Set<string>();
  for (const id of allowedUpstreams) {
    if (HEALTHY_UPSTREAMS.has(id)) routeHealthyUpstreams.add(id);
  }
  let upstreamId: string | null = null;
  let routeStage: string | undefined;
  let setCanaryCookieVal: string | undefined;

  if (pathRule?.canary?.enabled) {
    const canaryConf = pathRule.canary;
    const canaryId = canaryConf.canaryUpstream;
    const baselineId = canaryConf.baselineUpstream || (allowedUpstreams.length > 0 ? allowedUpstreams[0] : null);
    const cookieName = canaryConf.stickyCookieName || "NINJA_CANARY";
    const cookies = parseCookies(headers.cookie);
    const userCookie = cookies[cookieName];

    const isCanaryHealthy = canaryId ? HEALTHY_UPSTREAMS.has(canaryId) : false;
    const canaryBulkhead = canaryId ? upstreamBulkheads.get(canaryId) : undefined;
    const isCanaryAtCapacity = canaryId
      ? lb.isAtCapacity(canaryId, canaryConf.maxConnections) || (canaryBulkhead !== undefined && canaryBulkhead.availableSlots <= 0)
      : false;
    const isCanaryAvailable = isCanaryHealthy && !isCanaryAtCapacity;

    let headerMatched = false;
    if (canaryConf.headerKey && canaryConf.headerValue) {
      const incomingHeaderVal = headers[canaryConf.headerKey.toLowerCase()];
      if (incomingHeaderVal === canaryConf.headerValue) {
        if (isIpAllowed(clientIp, canaryConf.allowedIps)) {
          headerMatched = true;
        } else {
          logger.warn("Canary", `Header override ignored for client IP ${clientIp}: not in allowedIps whitelist`);
        }
      }
    }

    if (headerMatched) {
      if (isCanaryAvailable && !attemptedUpstreams.has(canaryId)) {
        upstreamId = canaryId;
        routeStage = canaryConf.stage || "canary";
      } else if (baselineId && HEALTHY_UPSTREAMS.has(baselineId) && !attemptedUpstreams.has(baselineId)) {
        logger.warn("Canary", `Canary upstream ${canaryId} at capacity; fallback to baseline ${baselineId}`);
        upstreamId = baselineId;
        routeStage = "baseline";
      }
    } else if (userCookie === "canary") {
      if (isCanaryAvailable && !attemptedUpstreams.has(canaryId)) {
        upstreamId = canaryId;
        routeStage = canaryConf.stage || "canary";
      } else if (baselineId && HEALTHY_UPSTREAMS.has(baselineId) && !attemptedUpstreams.has(baselineId)) {
        logger.warn("Canary", `Canary upstream ${canaryId} at capacity; fallback to baseline ${baselineId}`);
        upstreamId = baselineId;
        routeStage = "baseline";
      }
    } else if (userCookie === "baseline") {
      if (baselineId && HEALTHY_UPSTREAMS.has(baselineId) && !attemptedUpstreams.has(baselineId)) {
        upstreamId = baselineId;
        routeStage = "baseline";
      }
    } else {
      const weight = canaryConf.weight ?? 10;
      const roll = Math.random() * 100;
      if (roll < weight && isCanaryAvailable && !attemptedUpstreams.has(canaryId)) {
        upstreamId = canaryId;
        routeStage = canaryConf.stage || "canary";
        setCanaryCookieVal = "canary";
      } else if (baselineId && HEALTHY_UPSTREAMS.has(baselineId) && !attemptedUpstreams.has(baselineId)) {
        upstreamId = baselineId;
        routeStage = "baseline";
        setCanaryCookieVal = "baseline";
      }
    }
  }

  if (pathRule?.sticky && !upstreamId) {
    const cookies = parseCookies(headers.cookie);
    const stickId = cookies[workerConfig.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"];
    if (stickId && routeHealthyUpstreams.has(stickId) && !attemptedUpstreams.has(stickId)) {
      upstreamId = stickId;
    }
  }
  if (!upstreamId) {
    // A route with an explicit upstream list (every real route has one) must never borrow
    // another route's upstream just because its own list is currently empty/unhealthy — that
    // would let one tenant's request be answered by a different tenant's backend. Only a route
    // with NO upstream restriction at all (allowedUpstreams itself empty) uses the global pool.
    const candidateSet = allowedUpstreams.length > 0 ? routeHealthyUpstreams : HEALTHY_UPSTREAMS;
    upstreamId = lb.pickFiltered(candidateSet, clientIp, attemptedUpstreams, headers.cookie);
    if (!upstreamId && attemptedUpstreams.size > 0) {
      upstreamId = lb.pickFiltered(candidateSet, clientIp, new Set(), headers.cookie);
    }
  }
  if (!upstreamId) return null;
  return { upstreamId, routeStage, setCanaryCookieVal };
}

// -----------------------------------------------------------------------------
// The actual upstream call: builds outbound headers, makes the request, and
// either buffers a small error-ish body (so a retry/stale-fallback decision
// can still be made) or streams a success-ish body straight to the client
// with native backpressure the whole way (gzip + cache-tee + byte cap as
// transform stages ahead of the response).
// -----------------------------------------------------------------------------
interface AttemptOutcome {
  kind: "success" | "retryable-error" | "not-found" | "terminal-error" | "aborted";
  statusCode?: number;
  errorMessage?: string;
}

/** Threaded through one logical request's attempts so a client disconnect (res 'close'
 *  before writableEnded) can destroy whichever upstream call is currently in flight — and so
 *  that in-flight call, in turn, knows to skip writing to a client that's already gone. */
interface AbortHandle {
  aborted: boolean;
  destroy: (() => void) | undefined;
}

async function performUpstreamCall(
  upstreamId: string,
  serviceInstance: ServiceInstance,
  method: string,
  url: string,
  headers: Record<string, any>,
  clientIp: string,
  res: http.ServerResponse,
  bodySource:
    | { mode: "empty" }
    | { mode: "buffered"; buffer: Buffer }
    | { mode: "stream"; req: http.IncomingMessage; limit: number; prefix?: Buffer | undefined },
  pathRule: RouteRule | undefined,
  routeStage: string | undefined,
  setCanaryCookieVal: string | undefined,
  startTime: number,
  abortHandle: AbortHandle,
): Promise<AttemptOutcome> {
  // The caller (handleProxyDispatch's attempt()) already matched and validated this route
  // once for the whole request — no need to re-match here, which used to triple the
  // per-request route-matching cost (this was the third of three identical matches).
  const cleanPath = url.split("?")[0] ?? "/";

  const finalUpstreamUrl = new URL(serviceInstance.url);
  const isHttps = finalUpstreamUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = getAgent(isHttps);
  const upstreamStaticConfig = workerConfig.server.upstreams.find(
    (u) => u.url === finalUpstreamUrl.toString() || new URL(u.url).origin === finalUpstreamUrl.origin,
  );
  const tlsConfig = upstreamStaticConfig?.tls;
  const rejectUnauthorized = tlsConfig?.rejectUnauthorized ?? true;
  let caBuffer: Buffer | undefined;
  if (isHttps && tlsConfig?.ca) {
    try {
      caBuffer = readFileSync(tlsConfig.ca);
    } catch (err: any) {
      logger.error(`Worker:${process.pid}`, `Failed to read CA file: ${err.message}`, { ca: tlsConfig.ca });
    }
  }

  const forwardHeaders: Record<string, any> = { ...headers };
  delete forwardHeaders["transfer-encoding"];
  delete forwardHeaders["connection"];
  delete forwardHeaders["keep-alive"];
  forwardHeaders["host"] = finalUpstreamUrl.host;
  forwardHeaders["X-Real-IP"] = clientIp || "unknown";
  forwardHeaders["X-Forwarded-For"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${clientIp}` : clientIp || "unknown";
  forwardHeaders["X-Forwarded-Proto"] = headers["x-forwarded-proto"] || (isHttps ? "https" : "http");
  forwardHeaders["X-Forwarded-Host"] = headers["x-forwarded-host"] || headers["host"] || "localhost";
  forwardHeaders["X-Forwarded-Port"] =
    headers["x-forwarded-port"] || String(workerConfig.server.port || workerConfig.server.listen || (isHttps ? 8443 : 8080));
  if (headers["x-trace-id"]) forwardHeaders["X-Trace-Id"] = headers["x-trace-id"];
  forwardHeaders["X-Proxy-By"] = "Ninja-Reverse-Proxy";
  if (workerConfig.server.headers) {
    for (const h of workerConfig.server.headers) {
      forwardHeaders[h.key] = h.value === "client_ip" ? clientIp || "unknown" : h.value;
    }
  }
  if (bodySource.mode === "buffered") {
    forwardHeaders["content-length"] = String(bodySource.buffer.length);
  }

  const requestOptions: http.RequestOptions = {
    host: finalUpstreamUrl.hostname,
    port: finalUpstreamUrl.port || (isHttps ? "443" : "80"),
    path: url,
    method,
    agent,
    headers: forwardHeaders,
    ...(isHttps && { rejectUnauthorized, ...(caBuffer ? { ca: caBuffer } : {}) }),
  };

  return new Promise<AttemptOutcome>((resolveOutcome) => {
    let connectTimeoutTimer: NodeJS.Timeout;
    // Read-phase timeout: a socket-level idle timer (armed once upstreamRes exists, covering
    // both the small buffered error-body path and the streamed success path) rather than a
    // JS-level clearTimeout()+setTimeout() pair reset by hand on every single chunk. The
    // socket's own idle timer already resets itself on any read/write activity, so this gets
    // the identical "abort if nothing happens for readTimeoutMs" behavior without per-chunk
    // timer churn.
    let idleTimeoutArmed = false;
    // Deliberately a different name from the response callback's own `upstreamRes` parameter
    // below — it assigns into this one so onIdleTimeout/clearIdleTimeout (defined before that
    // callback exists) can still reach it via closure, without the parameter shadowing it.
    let activeUpstreamRes: http.IncomingMessage | undefined;
    // Captured directly at arm time rather than re-read from activeUpstreamRes.socket later:
    // Node nulls out IncomingMessage.socket once the message is fully consumed (to avoid the
    // *caller* holding a stale reference), so by the time a success response finishes writing
    // to the client and clearIdleTimeout() runs, activeUpstreamRes.socket is already null —
    // removeListener on it silently no-ops, and the 'timeout' listener this armed (plus the
    // whole closure scope it keeps alive — upstreamRes/proxyReq/res and every sibling closure
    // here) leaks for the life of the pooled, keep-alive-reused socket.
    let timeoutSocket: net.Socket | undefined;
    const onIdleTimeout = () => {
      try { proxyReq.destroy(); } catch {}
      try { activeUpstreamRes?.destroy(); } catch {}
    };
    const clearIdleTimeout = () => {
      if (!idleTimeoutArmed) return;
      idleTimeoutArmed = false;
      try { timeoutSocket?.setTimeout(0); } catch {}
      try { timeoutSocket?.removeListener("timeout", onIdleTimeout); } catch {}
      timeoutSocket = undefined;
    };
    let settled = false;
    const finishOutcome = (o: AttemptOutcome) => {
      if (settled) return;
      settled = true;
      abortHandle.destroy = undefined;
      if (o.kind === "aborted") {
        resolveOutcome(o);
        return;
      }
      const latencyMs = performance.now() - startTime;
      if (o.kind === "success") {
        lb.recordSuccess(upstreamId, latencyMs);
        passiveProbe.record({ upstreamId, statusCode: o.statusCode ?? 200, latencyMs });
      } else {
        lb.recordFailure(upstreamId);
        passiveProbe.record({ upstreamId, statusCode: o.statusCode ?? 502, latencyMs });
      }
      upstreamBulkheads.get(upstreamId)?.leave();
      metricsRegistry.recordActiveConnection(upstreamId, -1);
      lb.releaseConnection(upstreamId);
      resolveOutcome(o);
    };

    if (abortHandle.aborted) {
      finishOutcome({ kind: "aborted" });
      return;
    }

    const proxyReq = transport.request(requestOptions, (upstreamRes) => {
      activeUpstreamRes = upstreamRes;
      abortHandle.destroy = () => {
        try {
          proxyReq.destroy();
        } catch {}
        try {
          upstreamRes.destroy();
        } catch {}
      };
      if (abortHandle.aborted) {
        clearTimeout(connectTimeoutTimer);
        finishOutcome({ kind: "aborted" });
        return;
      }
      clearTimeout(connectTimeoutTimer);
      // Idle timeout for the whole read phase, armed once here: the socket's own timer
      // resets on any read/write activity, so this covers both the small buffered error-body
      // path below and the streamed success path further down with one mechanism, and
      // without the per-chunk clearTimeout()+setTimeout() churn a JS-level timer would need.
      if (upstreamRes.socket) {
        timeoutSocket = upstreamRes.socket;
        timeoutSocket.setTimeout(workerConfig.server.readTimeoutMs, onIdleTimeout);
        idleTimeoutArmed = true;
      }
      const statusCode = upstreamRes.statusCode ?? 200;
      const isErrorish = statusCode >= 400;

      if (isErrorish) {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let aborted = false;
        upstreamRes.on("data", (chunk: Buffer) => {
          if (aborted) return;
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            aborted = true;
            clearIdleTimeout();
            upstreamRes.destroy();
            proxyReq.destroy();
            recordAndLog(502, receivedBytes, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
            finishOutcome({ kind: "terminal-error", statusCode: 502, errorMessage: "Upstream response exceeded maximum allowed size" });
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on("end", () => {
          if (aborted) return;
          clearIdleTimeout();
          const bodyBuffer = Buffer.concat(chunks);
          recordAndLog(statusCode, bodyBuffer.length, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
          void finalizeErrorish(statusCode, bodyBuffer).then(finishOutcome);
        });
        upstreamRes.on("error", () => {
          if (aborted) return;
          aborted = true;
          clearIdleTimeout();
          finishOutcome({ kind: "terminal-error", statusCode: 502, errorMessage: "Upstream response error" });
        });
        return;
      }

      // Success-ish: commit headers to the client now (TTFB matches upstream's own), then
      // stream the body with native backpressure end-to-end.
      const acceptEncoding = headers["accept-encoding"] || "";
      const contentType = String(upstreamRes.headers["content-type"] || "");
      const isCompressible = /json|text|javascript|css/.test(contentType);
      const upstreamEncoding = upstreamRes.headers["content-encoding"];
      const shouldGzip =
        !upstreamEncoding && Boolean(workerConfig.server.compression) && isCompressible && acceptEncoding.includes("gzip");

      // A declared Content-Length within the cap is trusted upfront — Node's own HTTP parser
      // never delivers more body bytes than a well-formed response declared (extra bytes on
      // the socket are parsed as the start of the next response, not appended to this one), so
      // this isn't a weaker check than the streaming byte-guard below, just an earlier one.
      // An oversized declared length is rejected before writeHead ever runs, instead of (as
      // before) always starting to stream and only discovering the overage mid-flight.
      const contentLengthHeader = upstreamRes.headers["content-length"];
      let declaredContentLength: number | undefined;
      if (typeof contentLengthHeader === "string") {
        const parsed = Number(contentLengthHeader);
        if (Number.isFinite(parsed) && parsed >= 0) declaredContentLength = parsed;
      }
      if (declaredContentLength !== undefined && declaredContentLength > maxResponseBytes) {
        clearIdleTimeout();
        upstreamRes.resume();
        upstreamRes.destroy();
        proxyReq.destroy();
        recordAndLog(502, 0, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
        finishOutcome({ kind: "terminal-error", statusCode: 502, errorMessage: "Upstream response exceeded maximum allowed size" });
        return;
      }
      // Gzip recompression changes the byte count the cap is meant to bound (the declared
      // length describes the upstream's uncompressed body), so the active guard stays in
      // place whenever shouldGzip is true regardless of what Content-Length declared.
      const skipByteGuard = !shouldGzip && declaredContentLength !== undefined && declaredContentLength <= maxResponseBytes;

      const replyHeaders: Record<string, any> = { ...upstreamRes.headers };
      if (shouldGzip) {
        replyHeaders["content-encoding"] = "gzip";
        delete replyHeaders["content-length"];
      }
      delete replyHeaders["transfer-encoding"];
      delete replyHeaders["connection"];

      const isCacheMethod = method === "GET" || method === "HEAD";
      const hasSetCookie = !!replyHeaders["set-cookie"];
      const effCache = getEffectiveCache(workerConfig);
      const isCacheable =
        Boolean(effCache?.enabled) &&
        (statusCode === 200 || statusCode === 301) &&
        !headers["authorization"] &&
        !hasSetCookie &&
        pathRule?.cache?.enabled !== false &&
        cache.isResponseCacheable(replyHeaders) &&
        isCacheMethod;

      const responseHeaders: Record<string, any> = { "X-Upstream-Id": upstreamId, ...replyHeaders };
      if (effCache?.enabled && isCacheMethod) responseHeaders["X-Cache"] = "MISS";
      if (routeStage) responseHeaders["X-Route-Stage"] = routeStage;
      const setCookieList: string[] = [];
      const upstreamSetCookie = replyHeaders["set-cookie"];
      if (upstreamSetCookie) {
        if (Array.isArray(upstreamSetCookie)) setCookieList.push(...upstreamSetCookie);
        else setCookieList.push(upstreamSetCookie);
      }
      if (pathRule?.sticky) {
        const maxAge = workerConfig.server.loadBalancing.stickyCookieTtlMs
          ? `; Max-Age=${Math.round(workerConfig.server.loadBalancing.stickyCookieTtlMs / 1000)}`
          : "";
        setCookieList.push(`${workerConfig.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"}=${upstreamId}; Path=/; HttpOnly; SameSite=Lax${maxAge}`);
      }
      if (setCanaryCookieVal && pathRule?.canary) {
        const cName = pathRule.canary.stickyCookieName || "NINJA_CANARY";
        setCookieList.push(`${cName}=${setCanaryCookieVal}; Path=/; HttpOnly; SameSite=Lax`);
      }
      if (setCookieList.length > 0) {
        responseHeaders["Set-Cookie"] = setCookieList.length === 1 ? setCookieList[0] : setCookieList;
      }

      res.writeHead(statusCode, responseHeaders);

      if (method === "HEAD") {
        upstreamRes.resume();
        res.end();
        clearIdleTimeout();
        recordAndLog(statusCode, 0, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
        if (isCacheMethod) metricsRegistry.recordCacheOp("miss");
        finishOutcome({ kind: "success", statusCode });
        return;
      }

      const cacheChunks: Buffer[] = [];

      // Chained by hand with .pipe() rather than stream.pipeline() — pipeline()'s automatic
      // per-stream finished()/eos() bookkeeping is real overhead relative to a typical small
      // JSON response (measured ~30% of this gate's throughput). .pipe() gives the exact same
      // backpressure guarantee end-to-end; the cost is that *this* code must do the error-
      // propagation and cleanup pipeline() would otherwise have handled, via destroyAll below.
      //
      // The byte-guard Transform is skipped entirely when skipByteGuard is true (declared
      // Content-Length already proved the body is within maxResponseBytes, see above) — one
      // fewer stream stage, and one fewer thing counting bytes, for the common case of a
      // normal-sized, non-chunked response. It's still built for anything whose size isn't
      // known upfront (chunked transfer-encoding, or no Content-Length at all).
      const liveStreams: Array<{ destroy?: () => void }> = [upstreamRes, res];
      let source: NodeJS.ReadableStream = upstreamRes;
      if (shouldGzip) {
        const gz = zlib.createGzip();
        liveStreams.push(gz);
        source = source.pipe(gz);
      }
      let byteGuard: Transform | undefined;
      if (!skipByteGuard) {
        byteGuard = createByteLimitGuard(maxResponseBytes);
        liveStreams.push(byteGuard);
        source = source.pipe(byteGuard);
      }
      if (isCacheable) {
        const tee = createTeeTransform((buf) => cacheChunks.push(buf));
        liveStreams.push(tee);
        source = source.pipe(tee);
      }
      source.pipe(res);

      let streamSettled = false;
      const destroyAll = () => {
        for (const s of liveStreams) {
          try {
            s.destroy?.();
          } catch {}
        }
      };
      const onStreamDone = () => {
        if (streamSettled) return;
        streamSettled = true;
        clearIdleTimeout();
        void (async () => {
          const latencyMs = performance.now() - startTime;
          recordAndLog(statusCode, 0, latencyMs, method, cleanPath, upstreamId, headers, clientIp);
          if (isCacheMethod) metricsRegistry.recordCacheOp("miss");
          if (isCacheable) {
            const maxAgeSeconds = pathRule?.cache?.ttlSeconds ?? effCache.ttlSeconds;
            const physicalTtlSeconds = maxAgeSeconds + (effCache.staleIfErrorSeconds ?? 86400);
            const bodyBuffer = Buffer.concat(cacheChunks);
            const parsedUrl = new URL(url, "http://dummy");
            const cacheKey = cache.buildKey(method, parsedUrl.pathname + parsedUrl.search, headers);
            const tagHeader = replyHeaders["cache-tag"] ?? replyHeaders["x-cache-tags"];
            const tags = tagHeader
              ? (Array.isArray(tagHeader) ? tagHeader.join(",") : String(tagHeader)).split(",").map((t: string) => t.trim()).filter(Boolean)
              : undefined;
            await cache.set(
              cacheKey,
              JSON.stringify({ statusCode, headers: replyHeaders, body: bodyBuffer.toString("base64"), storedAt: Date.now(), maxAgeSeconds }),
              physicalTtlSeconds,
              tags,
            );
          }
          finishOutcome({ kind: "success", statusCode });
        })();
      };
      const onStreamError = (err: any) => {
        if (streamSettled) return;
        streamSettled = true;
        clearIdleTimeout();
        destroyAll();
        if (abortHandle.aborted) {
          finishOutcome({ kind: "aborted" });
          return;
        }
        logger.error("Worker", `Upstream response stream aborted: ${err.message}`, { upstreamId });
        // res.writeHead(statusCode, ...) already ran before this stream existed (see above) --
        // the client already received that status line, so logging the synthetic 502 this used
        // to pass here would be a lie, and skipping recordAndLog entirely (as this did until
        // now) silently dropped every mid-stream upstream failure from both Prometheus and the
        // access log, unlike every other terminal outcome in this function.
        recordAndLog(statusCode, 0, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
        finishOutcome({ kind: "terminal-error", statusCode, errorMessage: err.message });
      };
      res.on("finish", onStreamDone);
      res.on("error", onStreamError);
      upstreamRes.on("error", onStreamError);
      byteGuard?.on("error", onStreamError);
    });

    // Covers the connecting phase, before any 'response' event: if the client disconnects
    // before upstreamRes even exists, this is the only handle available to cancel the
    // pending connection. Overwritten (to also destroy upstreamRes) once the response
    // callback above runs.
    abortHandle.destroy = () => {
      try {
        proxyReq.destroy();
      } catch {}
    };

    connectTimeoutTimer = setTimeout(() => {
      if (abortHandle.aborted) {
        finishOutcome({ kind: "aborted" });
        return;
      }
      clearIdleTimeout();
      proxyReq.destroy();
      recordAndLog(504, 0, workerConfig.server.connectTimeoutMs, method, cleanPath, upstreamId, headers, clientIp);
      finishOutcome({ kind: "retryable-error", statusCode: 504, errorMessage: "Connect Timeout" });
    }, workerConfig.server.connectTimeoutMs);

    proxyReq.on("error", (err: any) => {
      clearTimeout(connectTimeoutTimer);
      clearIdleTimeout();
      // proxyReq.destroy() (e.g. the request-body byte-limit guard tearing down an oversized
      // upload) fires this 'error' event asynchronously, after the outcome it caused has
      // already been finishOutcome()'d with its own, correct status. finishOutcome() itself
      // no-ops on a second call, but logger.error/recordAndLog below are not otherwise
      // guarded — without this check, every request this handler fires for ends up double-
      // logged: once with its real status, then again moments later as a spurious 502 here.
      if (settled) return;
      if (abortHandle.aborted) {
        finishOutcome({ kind: "aborted" });
        return;
      }
      logger.error(`Worker:${process.pid}`, `proxyReq error: ${err.message} (${err.code})`);
      recordAndLog(502, 0, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
      finishOutcome({ kind: "retryable-error", statusCode: 502, errorMessage: `Upstream connection failed: ${err.message}` });
    });

    if (bodySource.mode === "empty") {
      // The overwhelmingly common case (GET/HEAD, no body) skips stream.pipeline() entirely
      // — profiling under load showed its internal AbortController/eos() bookkeeping (needed
      // to replay backpressure/error state between two real streams) costing real CPU even
      // when there's nothing to stream; a bodyless request has nothing for it to do.
      proxyReq.end();
    } else if (bodySource.mode === "buffered") {
      if (bodySource.buffer.length > 0) proxyReq.write(bodySource.buffer);
      proxyReq.end();
    } else {
      // A retry-buffer overflow (see handleProxyDispatch) already consumed `prefix` bytes from
      // `req` before giving up on buffering — write them first, in order, then pipe the rest of
      // the live stream. The guard's count starts at prefix.length so the combined prefix+stream
      // total is still held to the same limit, instead of allowing `limit` bytes on top of it.
      if (bodySource.prefix && bodySource.prefix.length > 0) proxyReq.write(bodySource.prefix);
      const guard = createByteLimitGuard(bodySource.limit, undefined, bodySource.prefix?.length ?? 0);
      pipeline(bodySource.req as any, guard as any, proxyReq as any).catch((err: any) => {
        clearTimeout(connectTimeoutTimer);
        if (err?.message === "BYTE_LIMIT_EXCEEDED") {
          try {
            proxyReq.destroy();
          } catch {}
          clearIdleTimeout();
          recordAndLog(413, 0, performance.now() - startTime, method, cleanPath, upstreamId, headers, clientIp);
          finishOutcome({ kind: "terminal-error", statusCode: 413, errorMessage: "Payload Too Large" });
        } else {
          // proxyReq's own 'error' handler above already resolves the outcome for a
          // connection-level failure; this just guards against an unhandled rejection.
        }
      });
    }
  });
}

function recordAndLog(
  statusCode: number,
  bytesSent: number,
  latencyMs: number,
  method: string,
  routePath: string,
  upstreamId: string,
  headers: Record<string, any>,
  clientIp: string,
) {
  const tenantId = (headers["x-tenant-id"] as string) ?? "none";
  metricsRegistry.recordRequest(method, routePath, statusCode, upstreamId || "unknown", latencyMs, tenantId);
  const logPath =
    workerConfig.observability?.logging?.accessLog === true
      ? "logs/access.log"
      : typeof workerConfig.observability?.logging?.accessLog === "string"
        ? workerConfig.observability.logging.accessLog
        : undefined;
  if (logPath) {
    void writeAccessLog(logPath, clientIp || "unknown", method, routePath, statusCode, bytesSent, latencyMs, (headers["user-agent"] as string) ?? "-");
  }
  if (workerConfig.observability?.tenantDelivery?.mode === "webhook") {
    tenantLogStreamer.queueLog(tenantId, {
      timestamp: new Date().toISOString(),
      clientIp: clientIp || "unknown",
      method,
      url: routePath,
      statusCode,
      bytesSent,
      latencyMs,
      userAgent: (headers["user-agent"] as string) ?? "-",
    });
  }
}

async function finalizeErrorish(statusCode: number, bodyBuffer: Buffer): Promise<AttemptOutcome> {
  // lb/bulkhead/connection accounting and passiveProbe recording happen centrally in
  // performUpstreamCall's finishOutcome() — this just builds the outcome to resolve with.
  return { kind: "retryable-error", statusCode, errorMessage: bodyBuffer.toString("binary") };
}

// -----------------------------------------------------------------------------
// Full per-request dispatch: upstream selection (canary/sticky/LB), bulkhead,
// then the attempt+retry loop. This is a direct port of the old master.ts
// dispatchToWorker()'s decision logic, with the IPC send replaced by a
// direct performUpstreamCall().
// -----------------------------------------------------------------------------
async function handleProxyDispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientIp: string,
  pathRule: RouteRule | undefined,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const startTime = performance.now();

  if (!pathRule) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route not found" }));
    recordAndLog(404, 0, performance.now() - startTime, method, url.split("?")[0] ?? url, "none", req.headers, clientIp);
    return;
  }

  const rule: RouteRule = pathRule;
  const effectiveBodyLimit = rule.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES_DEFAULT;
  const retryBufferLimit = rule.retryBufferLimitBytes ?? RETRY_BUFFER_LIMIT_BYTES_DEFAULT;
  const retryConfig = workerConfig.server.loadBalancing.retry;
  const effectiveResilience = getEffectiveResilience(workerConfig);
  const methodRetrySafe = isMethodRetrySafe(method, req.headers, effectiveResilience?.retry?.retryMutatingMethods ?? false);
  const contentLengthHeader = req.headers["content-length"];
  const contentLength = parseInt(String(contentLengthHeader ?? "0"), 10);
  const hasBody = contentLength > 0 || req.headers["transfer-encoding"] === "chunked";
  const canRetry = retryConfig.maxAttempts > 0;
  const retryBufferingWanted = hasBody && canRetry && methodRetrySafe;
  // A known Content-Length over the limit never needs to read a byte before deciding to
  // stream — only an unknown (chunked) length has to be read incrementally to find out.
  const contentLengthKnownOversized = retryBufferingWanted && contentLengthHeader !== undefined && contentLength > retryBufferLimit;
  const useBufferedBody = retryBufferingWanted && !contentLengthKnownOversized;

  let bufferedBody: Buffer | undefined;
  let streamPrefix: Buffer | undefined;
  if (useBufferedBody) {
    const result = await new Promise<{ ok: true; buffer: Buffer } | { ok: true; prefix: Buffer } | { ok: false }>((resolve) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const onData = (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > effectiveBodyLimit) {
          settled = true;
          cleanup();
          req.destroy();
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload Too Large" }));
          resolve({ ok: false });
          return;
        }
        chunks.push(chunk);
        if (received > retryBufferLimit) {
          // Over the retry-buffer limit but still under the hard body-size cap: give up on
          // buffering (and therefore on retrying this request) rather than hold the rest of
          // a large body in memory too. Pause the stream — removing our own listeners first —
          // so performUpstreamCall can later write these already-read bytes, then pipe the
          // untouched remainder of `req` straight through with no gap or duplication.
          settled = true;
          cleanup();
          req.pause();
          resolve({ ok: true, prefix: Buffer.concat(chunks) });
        }
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: true, buffer: Buffer.concat(chunks) });
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false });
      };
      function cleanup() {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
      }
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
    });
    if (!result.ok) return; // 413 already sent, or the client errored with no response to give
    if ("buffer" in result) bufferedBody = result.buffer;
    else streamPrefix = result.prefix;
  }

  let bodyStreamed = false;
  let clientAborted = false;
  const abortHandle: AbortHandle = { aborted: false, destroy: undefined };
  let currentUpstreamId: string | undefined;
  res.on("close", () => {
    if (res.writableEnded) return;
    clientAborted = true;
    abortHandle.aborted = true;
    abortHandle.destroy?.();
    if (currentUpstreamId) {
      upstreamBulkheads.get(currentUpstreamId)?.leave();
      metricsRegistry.recordActiveConnection(currentUpstreamId, -1);
      lb.recordAbort(currentUpstreamId);
      logger.warn("Worker", "Client disconnected before response completed — aborted in-flight upstream request", { upstreamId: currentUpstreamId });
      currentUpstreamId = undefined;
    }
  });

  async function attempt(attemptNum: number, attemptedUpstreams: Set<string>, previousSleepMs?: number): Promise<void> {
    if (clientAborted) return;
    globalRetryBudget.recordRequest();
    const selected = selectUpstream(pathRule, req.headers, clientIp, attemptedUpstreams);
    if (!selected) {
      const servedStale = await tryServeStaleOnError({ requestType: method, url, headers: req.headers }, pathRule, 503, res);
      if (!servedStale) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No healthy upstreams available" }));
      }
      recordAndLog(servedStale ? 200 : 503, 0, performance.now() - startTime, method, rule.path, "none", req.headers, clientIp);
      return;
    }
    const { upstreamId, routeStage, setCanaryCookieVal } = selected;
    attemptedUpstreams.add(upstreamId);

    const bulkheadConf = effectiveResilience?.bulkhead;
    if (bulkheadConf?.enabled ?? false) {
      let bulkhead = upstreamBulkheads.get(upstreamId);
      if (!bulkhead) {
        const upstreamConf = workerConfig.server.upstreams.find((u) => u.id === upstreamId);
        bulkhead = new Bulkhead(bulkheadConf?.maxConcurrentPerUpstream ?? upstreamConf?.maxConnections ?? 1000);
        upstreamBulkheads.set(upstreamId, bulkhead);
      }
      if (!bulkhead.enter()) {
        logger.warn("Resilience", `Bulkhead capacity reached for upstream: ${upstreamId}`);
        lb.cancelProbe(upstreamId);
        const retryAllowed = globalRetryBudget.recordRetry();
        if (retryAllowed && attemptNum < retryConfig.maxAttempts) {
          return attempt(attemptNum + 1, attemptedUpstreams, previousSleepMs);
        }
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service unavailable — upstream concurrency limit reached" }));
        recordAndLog(503, 0, performance.now() - startTime, method, rule.path, upstreamId, req.headers, clientIp);
        return;
      }
    }

    metricsRegistry.recordActiveConnection(upstreamId, 1);
    lb.incrementConnection(upstreamId);
    currentUpstreamId = upstreamId;
    const serviceInstance = registryMirror.get(upstreamId);
    if (!serviceInstance) {
      currentUpstreamId = undefined;
      upstreamBulkheads.get(upstreamId)?.leave();
      metricsRegistry.recordActiveConnection(upstreamId, -1);
      lb.releaseConnection(upstreamId);
      lb.cancelProbe(upstreamId);
      res.writeHead(503);
      res.end("Service not found in registry");
      recordAndLog(503, 0, performance.now() - startTime, method, rule.path, upstreamId, req.headers, clientIp);
      return;
    }

    const bodySource: Parameters<typeof performUpstreamCall>[7] =
      useBufferedBody && bufferedBody !== undefined
        ? { mode: "buffered", buffer: bufferedBody }
        : hasBody
          ? { mode: "stream", req, limit: effectiveBodyLimit, prefix: streamPrefix }
          : { mode: "empty" };
    if (bodySource.mode === "stream" && hasBody) {
      // Point of no return: once we start piping the client's body into this attempt, the
      // stream can never be replayed for a later attempt. Safe here because useBufferedBody
      // already covers every case where a retry after a body-bearing failure is both policy-
      // allowed and method-safe — reaching this branch means neither applies. A bodyless
      // request (the common GET/HEAD case) never reaches this "point of no return" at all:
      // piping an empty req is a no-op, so retrying it on a later attempt is always safe —
      // without the `hasBody` check here, retries for ordinary GETs were being blocked
      // unconditionally just because "stream" mode was chosen.
      bodyStreamed = true;
    }

    const outcome = await performUpstreamCall(
      upstreamId,
      serviceInstance,
      method,
      url,
      req.headers,
      clientIp,
      res,
      bodySource,
      pathRule,
      routeStage,
      setCanaryCookieVal,
      startTime,
      abortHandle,
    );
    // Once this attempt finishes on its own (any outcome), the close handler above must not
    // act on it a second time — currentUpstreamId is only meaningful while a call is in flight.
    if (currentUpstreamId === upstreamId) currentUpstreamId = undefined;

    if (outcome.kind === "aborted" || clientAborted) return;
    if (outcome.kind === "success") return;
    if (outcome.kind === "not-found") {
      upstreamBulkheads.get(upstreamId)?.leave();
      metricsRegistry.recordActiveConnection(upstreamId, -1);
      lb.releaseConnection(upstreamId);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: outcome.errorMessage || "Route not found" }));
      return;
    }

    const errorStatus = outcome.statusCode ?? 502;
    const isRetryable = outcome.kind === "retryable-error" || retryConfig.statusCodes.includes(errorStatus);
    if (isRetryable && !bodyStreamed) {
      const isLocalFailure = errorStatus === 500 || errorStatus === 502;
      const resilienceRetryConf = effectiveResilience?.retry;
      const policyAllowsRetry = isLocalFailure
        ? (resilienceRetryConf?.retryOn?.localNodeFailure ?? true)
        : (resilienceRetryConf?.retryOn?.systemOverload ?? true);
      const retryAllowed = policyAllowsRetry && methodRetrySafe && globalRetryBudget.recordRetry();
      if (retryAllowed && attemptNum < retryConfig.maxAttempts) {
        if (isLocalFailure) {
          return attempt(attemptNum + 1, attemptedUpstreams, undefined);
        }
        const baseDelayMs = resilienceRetryConf?.baseDelayMs ?? 100;
        const maxDelayMs = resilienceRetryConf?.maxDelayMs ?? 5000;
        const backoffType = resilienceRetryConf?.backoff ?? "full-jitter";
        let jitterDelay: number;
        switch (backoffType) {
          case "exponential":
            jitterDelay = calculateExponentialBackoff(attemptNum, baseDelayMs, maxDelayMs);
            break;
          case "equal-jitter":
            jitterDelay = calculateEqualJitterBackoff(attemptNum, baseDelayMs, maxDelayMs);
            break;
          case "decorrelated-jitter":
            jitterDelay = calculateDecorrelatedJitterBackoff(attemptNum, baseDelayMs, maxDelayMs, previousSleepMs);
            break;
          default:
            jitterDelay = calculateFullJitterBackoff(attemptNum, baseDelayMs, maxDelayMs);
        }
        await new Promise((r) => setTimeout(r, jitterDelay));
        return attempt(attemptNum + 1, attemptedUpstreams, jitterDelay);
      }
    }

    // A mid-stream failure (onStreamError above) reaches here too, and by then res.writeHead()
    // already ran once for the upstream's original status line -- headers can never be sent
    // twice. Both tryServeStaleOnError and the plain error response below call res.writeHead()
    // unconditionally; without this guard, every such failure threw ERR_HTTP_HEADERS_SENT as
    // an uncaught exception and took the whole worker down (confirmed directly: a real
    // upstream reset after sending headers + a partial body crashed a worker every time).
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const servedStale = await tryServeStaleOnError({ requestType: method, url, headers: req.headers }, pathRule, errorStatus, res);
    if (!servedStale) {
      res.writeHead(errorStatus, { "Content-Type": "application/json" });
      res.end(outcome.errorMessage || "Bad Gateway");
    }
  }

  await attempt(0, new Set<string>());
}

// -----------------------------------------------------------------------------
// WebSocket upgrade — tunneled directly, no socket handoff needed since this
// worker already owns the accepted client connection.
// -----------------------------------------------------------------------------
function wsUpgradeHandler(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const startTime = performance.now();
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const pathRule = routeMatcher.match(url.pathname, req.method);
  if (!pathRule) {
    socket.destroy();
    recordAndLog(404, 0, performance.now() - startTime, req.method ?? "GET", url.pathname, "none", req.headers, req.socket.remoteAddress ?? "unknown");
    return;
  }
  const clientIP = resolveClientIp(req, socket, {
    trustProxy: workerConfig.server.trustProxy,
    trustedProxies: workerConfig.server.trustedProxies,
  });
  const selected = selectUpstream(pathRule, req.headers, clientIP, new Set());
  if (!selected) {
    socket.destroy();
    recordAndLog(503, 0, performance.now() - startTime, req.method ?? "GET", pathRule.path, "none", req.headers, clientIP);
    return;
  }
  const { upstreamId } = selected;
  const serviceInstance = registryMirror.get(upstreamId);
  if (!serviceInstance) {
    lb.cancelProbe(upstreamId);
    socket.destroy();
    recordAndLog(503, 0, performance.now() - startTime, req.method ?? "GET", pathRule.path, upstreamId, req.headers, clientIP);
    return;
  }
  const outgoingHeaders = { ...req.headers };
  if (pathRule?.canary?.headerKey && pathRule?.canary?.stripHeader !== false) {
    delete outgoingHeaders[pathRule.canary.headerKey.toLowerCase()];
  }
  const reqFields = { method: req.method ?? "GET", url: req.url ?? "/", httpVersion: req.httpVersion, headers: outgoingHeaders };
  lb.incrementConnection(upstreamId);
  metricsRegistry.recordActiveConnection(upstreamId, 1);
  const upstreamStaticConfig = workerConfig.server.upstreams.find((u) => u.id === upstreamId);
  const tlsConfig = socket instanceof tls.TLSSocket ? upstreamStaticConfig?.tls : undefined;
  // Logged as a 101 (Switching Protocols) the moment the tunnel is accepted -- the only
  // "response" a WebSocket upgrade ever sends, same convention nginx's own access log uses.
  recordAndLog(101, 0, performance.now() - startTime, req.method ?? "GET", pathRule.path, upstreamId, req.headers, clientIP);
  tunnelWebSocket(socket, serviceInstance.url, reqFields, head, tlsConfig, () => {
    lb.releaseConnection(upstreamId);
    metricsRegistry.recordActiveConnection(upstreamId, -1);
  });
}

// -----------------------------------------------------------------------------
// Main request handler: admin endpoints, then the middleware pipeline (CORS,
// tracing, auth, rate limit, cache), then dispatch.
// -----------------------------------------------------------------------------
const proxyRequestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  activeRequestCount++;
  res.on("close", () => {
    activeRequestCount--;
    maybeExitWhenDrained();
  });

  const isAdmin = await handleAdminRequest({
    req,
    res,
    config: workerConfig,
    lb,
    healthyUpstreams: HEALTHY_UPSTREAMS,
    retryBudget: globalRetryBudget,
    metricsRegistry,
    cache,
    collectWorkerMetricSnapshots,
    registry: registryClient,
    broadcastCdcInvalidate: requestCdcInvalidateBroadcast,
  });
  if (isAdmin) return;

  const ctx = createContext(req, res, { trustProxy: workerConfig.server.trustProxy, trustedProxies: workerConfig.server.trustedProxies });
  const pipelineRunner = new MiddlewarePipeline();

  // Matched once per request and reused by every stage below (including the final dispatch
  // stage) — req.url/req.method never change mid-request, so the old pattern of every stage
  // separately re-parsing the URL and re-running the route matcher was pure repeated cost.
  const url = new URL(req.url!, `https://${req.headers.host}`);
  const pathRule = routeMatcher.match(url.pathname, req.method);

  pipelineRunner.use(async (c, next) => {
    const guard = corsMiddleware(pathRule?.cors ?? {}, (c2) => {
      recordAndLog(204, 0, performance.now() - c2.startTime, c2.req.method ?? "OPTIONS", pathRule?.path ?? url.pathname, "cors", c2.req.headers, c2.clientIp);
    });
    await guard(c, next);
  });

  pipelineRunner.use(tracingMiddleware());

  pipelineRunner.use(async (c, next) => {
    if (pathRule?.auth?.tokens && pathRule.auth.tokens.length > 0) {
      const guard = authMiddleware(new Set(pathRule.auth.tokens));
      await guard(c, next);
    } else {
      await next();
    }
  });

  pipelineRunner.use(async (c, next) => {
    const clientIP = c.clientIp;

    const globalCheck = globalRateLimitConfigured
      ? await checkRateLimit("global", clientIP)
      : { limited: false, allowed: true, resetAt: 0, algorithm: "" };
    if (globalCheck.limited && !globalCheck.allowed) {
      const retryAfter = Math.ceil((globalCheck.resetAt - Date.now()) / 1000);
      c.res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(0, retryAfter)),
        "X-RateLimit-Scope": "global",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(globalCheck.resetAt),
        "X-RateLimit-Algorithm": globalCheck.algorithm,
      });
      recordAndLog(429, 0, 0, c.req.method ?? "GET", pathRule?.path ?? "unmatched", "rate-limiter", c.req.headers, clientIP);
      c.res.end(
        JSON.stringify({ error: "Too Many Requests", scope: "global", algorithm: globalCheck.algorithm, state: globalCheck.algoState, retryAfter: `${Math.max(0, retryAfter)}s` }),
      );
      return;
    }

    if (pathRule?.rateLimit && routeRateLimitConfigured(pathRule.path)) {
      const routeCheck = await checkRateLimit(`route:${pathRule.path}`, clientIP);
      if (routeCheck.limited && !routeCheck.allowed) {
        const retryAfter = Math.ceil((routeCheck.resetAt - Date.now()) / 1000);
        c.res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(0, retryAfter)),
          "X-RateLimit-Scope": "route",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(routeCheck.resetAt),
          "X-RateLimit-Algorithm": routeCheck.algorithm,
        });
        recordAndLog(429, 0, 0, c.req.method ?? "GET", pathRule?.path ?? "unmatched", "rate-limiter", c.req.headers, clientIP);
        c.res.end(JSON.stringify({ error: "Too Many Requests", scope: "route", retryAfter: `${Math.max(0, retryAfter)}s`, algorithm: routeCheck.algorithm }));
        return;
      }
    }
    await next();
  });

  pipelineRunner.use(async (c, next) => {
    const clientIP = c.clientIp;

    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const skipCache = url.pathname.startsWith("/api/upload/") || pathRule?.cache?.enabled === false;
      if (!skipCache) {
        const cacheKey = cache.buildKey(c.req.method ?? "GET", url.pathname + url.search, c.req.headers);
        const cachedJson = await cache.get(cacheKey);
        if (cachedJson) {
          try {
            const cached = JSON.parse(cachedJson);
            const ageSeconds = cached.storedAt ? (Date.now() - cached.storedAt) / 1000 : Infinity;
            const maxAgeSeconds = cached.maxAgeSeconds ?? getEffectiveCache(workerConfig).ttlSeconds;
            const isFresh = ageSeconds <= maxAgeSeconds;
            const canServeStale = !isFresh && cache.shouldRevalidate(cacheKey, ageSeconds, maxAgeSeconds);
            if (isFresh || canServeStale) {
              c.res.writeHead(cached.statusCode ?? 200, { ...(cached.headers || {}), "X-Cache": isFresh ? "HIT" : "STALE" });
              const bodyBuf = Buffer.from(cached.body, "base64");
              if (c.req.method === "HEAD") c.res.end();
              else c.res.end(bodyBuf);
              const tenantId = (c.req.headers["x-tenant-id"] as string) ?? "none";
              metricsRegistry.recordCacheOp("hit");
              metricsRegistry.recordRequest(c.req.method, pathRule?.path ?? "unmatched", cached.statusCode ?? 200, "cache", 0, tenantId);
              writeAccessLog(
                workerConfig.server.accessLog,
                clientIP,
                c.req.method,
                c.req.url ?? "",
                cached.statusCode ?? 200,
                c.req.method === "HEAD" ? 0 : Buffer.byteLength(bodyBuf),
                0,
                (c.req.headers["user-agent"] as string) ?? "-",
              );
              if (workerConfig.observability?.tenantDelivery?.mode === "webhook") {
                tenantLogStreamer.queueLog(tenantId, {
                  timestamp: new Date().toISOString(),
                  clientIp: clientIP,
                  method: "GET",
                  url: c.req.url ?? "",
                  statusCode: cached.statusCode ?? 200,
                  bytesSent: Buffer.byteLength(bodyBuf),
                  latencyMs: 0,
                  userAgent: (c.req.headers["user-agent"] as string) ?? "-",
                });
              }
              if (canServeStale) {
                cache.markRevalidating(cacheKey);
                void handleProxyDispatch(c.req, createNoopResponse(), clientIP, pathRule);
                setTimeout(() => cache.markRevalidationDone(cacheKey), (workerConfig.server.readTimeoutMs ?? 15000) + 2000).unref();
              }
              return;
            }
          } catch {
            // fall through on corrupt cache entry
          }
        }
      }
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method ?? "")) {
      await cache.invalidate(url.pathname);
    }
    await next();
  });

  pipelineRunner.use(async (c) => {
    await handleProxyDispatch(c.req, c.res, c.clientIp, pathRule);
  });

  await pipelineRunner.run(ctx);
};

// -----------------------------------------------------------------------------
// Server bootstrap — each worker listens on the same port; cluster shares it.
// -----------------------------------------------------------------------------
let sslOptions: { key: Buffer; cert: Buffer } = { key: Buffer.alloc(0), cert: Buffer.alloc(0) };
const tlsExplicitlyEnabled = Boolean(workerConfig.tls?.enabled || workerConfig.server.sslKeyPath);
try {
  const keyPath =
    workerConfig.server.sslKeyPath ||
    workerConfig.tls?.key ||
    (existsSync("/etc/ninja-proxy/certs/key.pem") ? "/etc/ninja-proxy/certs/key.pem" : "./key.pem");
  const certPath =
    workerConfig.server.sslCertPath ||
    workerConfig.tls?.cert ||
    (existsSync("/etc/ninja-proxy/certs/cert.pem") ? "/etc/ninja-proxy/certs/cert.pem" : "./cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    sslOptions = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } else if (tlsExplicitlyEnabled) {
    throw new Error(`Certificate files not found: ${keyPath} or ${certPath}`);
  }
} catch (err: any) {
  if (tlsExplicitlyEnabled) {
    logger.error(`Worker:${process.pid}`, `Failed to load TLS certificates: ${err.message}`);
    throw err;
  }
}

const isTlsEnabled = Boolean(workerConfig.tls?.enabled && sslOptions.key.length > 0);
const port = workerConfig.server.port ?? workerConfig.server.listen;
if (isTlsEnabled) {
  httpsServer = https.createServer(sslOptions, (req, res) => void proxyRequestHandler(req, res));
  httpsServer.on("upgrade", wsUpgradeHandler);
  if (workerConfig.tls?.redirectHttp ?? true) {
    httpServer = http.createServer((req, res) => {
      if (
        req.url?.startsWith("/__registry") ||
        req.url?.startsWith("/__ready") ||
        req.url?.startsWith("/__health") ||
        req.url?.startsWith("/__lb-stats") ||
        req.url?.startsWith("/metrics")
      ) {
        void proxyRequestHandler(req, res);
        return;
      }
      const httpsUrl = `https://${req.headers.host?.replace(String(port), String(workerConfig.tls?.httpsPort ?? workerConfig.server.httpsPort ?? 8443))}${req.url}`;
      res.writeHead(301, { Location: httpsUrl });
      res.end();
    });
  } else {
    httpServer = http.createServer((req, res) => void proxyRequestHandler(req, res));
    httpServer.on("upgrade", wsUpgradeHandler);
  }
} else {
  httpServer = http.createServer((req, res) => void proxyRequestHandler(req, res));
  httpServer.on("upgrade", wsUpgradeHandler);
}

const keepAliveTimeoutMs = workerConfig.server.keepAliveTimeoutMs ?? 65000;
const headersTimeoutMs = workerConfig.server.headersTimeoutMs ?? 66000;
for (const srv of [httpServer, httpsServer]) {
  if (!srv) continue;
  srv.keepAliveTimeout = keepAliveTimeoutMs;
  srv.headersTimeout = headersTimeoutMs;
}
const listenBacklog = workerConfig.server.backlog ?? 511;
httpServer.listen(port, listenBacklog);
if (httpsServer) {
  httpsServer.listen(workerConfig.tls?.httpsPort ?? workerConfig.server.httpsPort ?? 8443, listenBacklog);
}
