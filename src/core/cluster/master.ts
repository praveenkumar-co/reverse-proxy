import http from "http";
import https from "https";
import tls from "tls";
import { readFileSync } from "fs";
import fs from "node:fs";
import net from "net";
import { tunnelWebSocket } from "../proxy/websocket.handler.js";
import cluster, { type Worker } from "node:cluster";
import os from "node:os";
import { createClient } from "redis";
import type { RedisClientType } from "redis";

import {
  workerMessageReplySchema,
  type WorkerMessageType,
  type HttpReplyHeadersType,
  type HttpReplyChunkType,
  type HttpReplyEndType,
  type HttpReplyAbortType,
} from "./ipc.protocol.js";

import {
  initialHealthCheck,
  startHealthChecks,
  registerPassiveProbeListener,
} from "../../discovery/health/health.manager.js";
import { RateLimiter } from "../../ratelimit/rate-limiter.js";
import { LoadBalancer, createLoadBalancer } from "../../balancer/index.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";
import { Cache } from "../../cache/cache-manager.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { writeAccessLog, logger } from "../../observability/logger/logger.js";
import { tenantLogStreamer } from "../../observability/logger/tenant-log.streamer.js";
import { globalRetryBudget } from "../../resilience/retry/retry-budget.js";
import { Bulkhead } from "../../resilience/bulkhead/bulkhead.js";
import { calculateExponentialBackoff } from "../../resilience/retry/backoff/exponential.backoff.js";
import { calculateFullJitterBackoff } from "../../resilience/retry/backoff/full-jitter.backoff.js";
import { calculateEqualJitterBackoff } from "../../resilience/retry/backoff/equal-jitter.backoff.js";
import { calculateDecorrelatedJitterBackoff } from "../../resilience/retry/backoff/decorrelated-jitter.backoff.js";
import { passiveProbe } from "../../discovery/health/passive.probe.js";
import { readinessProbe } from "../../observability/health/readiness.js";
import { handleAdminRequest } from "../admin/admin.handler.js";
import { MiddlewarePipeline } from "../pipeline/middleware.pipeline.js";
import { createContext, resolveClientIp } from "../pipeline/context.js";
import { corsMiddleware } from "../../middleware/cors.middleware.js";
import { bodyLimitMiddleware } from "../../middleware/body-limit.middleware.js";
import { tracingMiddleware } from "../../middleware/tracing.middleware.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { RouteMatcher } from "../router/route.matcher.js";
import type { RouteRule } from "../router/route.types.js";
import { isMethodRetrySafe } from "../../resilience/retry/idempotency.js";
import type { RootConfigType } from "../../config/schemas/server.schema.js";

function getEffectiveCache(config: RootConfigType) {
  return config.cache ?? config.server.cache;
}

function getEffectiveRateLimit(config: RootConfigType) {
  return config.rateLimit ?? config.server.rateLimit;
}

function getEffectiveResilience(config: RootConfigType) {
  return config.resilience ?? config.server.resilience;
}

function getEffectiveLoadBalancing(config: RootConfigType) {
  return config.loadBalancing ?? config.server.loadBalancing;
}

function getEffectiveDiscovery(config: RootConfigType) {
  return config.discovery ?? config.server.discovery;
}

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

interface CreateServerConfig {
  port: number;
  workerCount: number;
  config: RootConfigType;
}

// Enforced both by the fast-path Content-Length check (bodyLimitMiddleware) and, authoritatively,
// by the incremental byte counter in the request-body accumulation loop below — the latter
// catches requests that omit Content-Length or lie about it (e.g. chunked transfer-encoding).
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
let WORKER_POOL: Worker[] = [];
let ACTIVE_CONFIG: RootConfigType;
let lb: LoadBalancer;
let routeMatcher: RouteMatcher;
let cache: Cache;
let metricsRegistry: MetricsRegistry;
let rlRedisClient: RedisClientType | undefined;
let healthCheckInterval: NodeJS.Timeout | undefined;
let passiveProbeRegistered = false;
const HEALTHY_UPSTREAMS: Set<string> = new Set();
const rateLimiters = new Map<string, RateLimiter>();
let globalRateLimiter: RateLimiter | undefined;
const upstreamBulkheads = new Map<string, Bulkhead>();
let nextWorkerIndex = 0;
let isShuttingDown = false;

// worker.send() returns false when the IPC pipe's internal write buffer is over its high
// water mark — same signal as a Writable stream's write() returning false. It does NOT mean
// the message failed or was dropped; Node has already queued it internally and will deliver
// it. The previous implementation here re-sent the same message when send() returned false,
// believing it had to retry a failed send — under concurrent load that put a second copy of
// the message on the wire, which is what caused duplicate upstream POSTs (each duplicate
// delivery to the worker became its own independent upstream request). No retry, no queue:
// just send once and let Node's own channel handle backpressure.
function workerSend(worker: Worker, msg: string): void {
  if (worker.isDead() || !worker.isConnected()) return;
  try {
    worker.send(msg);
  } catch {}
}

// Prevent duplicate cluster 'exit' listeners when reloadServerConfig() calls
// createServer() again on hot-reload. Node's cluster module is a singleton —
// adding the same logical listener a second time doubles worker respawns.
let clusterExitHandlerInstalled = false;

interface PendingRequest {
  // Used for the old single-shot reply: a connection-level failure (no upstream response at
  // all) or an error-ish upstream status (>=400) that master may still retry or serve from
  // stale cache — see worker.ts's isErrorish split.
  resolve: (parsed: any) => void;
  // Used for a success-ish upstream response (<400), streamed as it arrives rather than
  // buffered — see the HTTP_REPLY_HEADERS/CHUNK/END/ABORT protocol in ipc.protocol.ts.
  onHeaders?: (reply: HttpReplyHeadersType) => void;
  onChunk?: (reply: HttpReplyChunkType) => void;
  onEnd?: (reply: HttpReplyEndType) => void;
  onAbort?: (reply: HttpReplyAbortType) => void;
  timer: NodeJS.Timeout;
  upstreamId: string;
  startTime: number;
  payload: WorkerMessageType;
  clientIp: string;
  res: http.ServerResponse;
  worker: Worker;
}
const pendingRequests = new Map<string, PendingRequest>();

/**
 * Mutable per-logical-request handle threaded through dispatchToWorker (and updated on every
 * retry attempt) so a `req.on('close')` listener registered once, at the top of the request,
 * can always reach whichever attempt is currently in flight — including ones created by
 * retries after the listener was registered.
 */
interface AbortHandle {
  requestId?: string;
  worker?: Worker;
  aborted: boolean;
}

interface MetricQueryRequest {
  resolve: (snapshots: any[]) => void;
  pendingWorkers: Set<number>;
  results: any[];
  timer: NodeJS.Timeout;
}
const pendingMetricQueries = new Map<string, MetricQueryRequest>();

function setupWorkerMessageHandling(worker: Worker) {
  worker.on("message", async (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === "WEBSOCKET_CLOSED") {
        lb.releaseConnection(parsed.upstreamId);
        metricsRegistry.recordActiveConnection(parsed.upstreamId, -1);
        return;
      }
      if (parsed.type === "DUMP_METRICS_RESPONSE") {
        const query = pendingMetricQueries.get(parsed.requestId);
        if (query) {
          query.results.push(parsed.data);
          query.pendingWorkers.delete(worker.id);
          if (query.pendingWorkers.size === 0) {
            query.resolve(query.results);
          }
        }
        return;
      }
      if (parsed.type === "HTTP_REPLY_HEADERS") {
        const pending = parsed.requestId ? pendingRequests.get(parsed.requestId) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          pending.onHeaders?.(parsed);
        }
        return;
      }
      if (parsed.type === "HTTP_REPLY_CHUNK") {
        const pending = parsed.requestId ? pendingRequests.get(parsed.requestId) : undefined;
        pending?.onChunk?.(parsed);
        return;
      }
      if (parsed.type === "HTTP_REPLY_END") {
        const pending = parsed.requestId ? pendingRequests.get(parsed.requestId) : undefined;
        if (pending) {
          pendingRequests.delete(parsed.requestId);
          pending.onEnd?.(parsed);
        }
        return;
      }
      if (parsed.type === "HTTP_REPLY_ABORT") {
        const pending = parsed.requestId ? pendingRequests.get(parsed.requestId) : undefined;
        if (pending) {
          pendingRequests.delete(parsed.requestId);
          pending.onAbort?.(parsed);
        }
        return;
      }
      if (parsed.requestId) {
        const pending = pendingRequests.get(parsed.requestId);
        if (pending) {
          pendingRequests.delete(parsed.requestId);
          clearTimeout(pending.timer);
          pending.resolve(parsed);
        }
      }
    } catch (err: any) {
      logger.error("Master", `Error processing worker reply: ${err.message}`);
    }
  });
}
function broadcastUpstreams() {
  const payload = JSON.stringify({
    type: "UPDATE_SERVICES",
    healthyUpstreams: Array.from(HEALTHY_UPSTREAMS),
  });
  for (const w of WORKER_POOL) {
    if (w.isConnected()) {
      try {
        w.send(payload);
      } catch {}
    }
  }
}

function collectWorkerMetricSnapshots(): Promise<any[]> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeWorkers = WORKER_POOL.filter((w) => w.isConnected());

    if (activeWorkers.length === 0) {
      return resolve([]);
    }
    const pendingWorkers = new Set(activeWorkers.map((w) => w.id));
    const results: any[] = [];
    const cleanup = () => {
      const query = pendingMetricQueries.get(requestId);
      if (query) {
        clearTimeout(query.timer);
        pendingMetricQueries.delete(requestId);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(results);
    }, 500);
    pendingMetricQueries.set(requestId, {
      resolve: (data) => {
        cleanup();
        resolve(data);
      },
      pendingWorkers,
      results,
      timer,
    });
    const payload = JSON.stringify({ type: "DUMP_METRICS_REQUEST", requestId });
    for (const w of activeWorkers) {
      try {
        w.send(payload);
      } catch {
        pendingWorkers.delete(w.id);
      }
    }
    if (pendingWorkers.size === 0) {
      cleanup();
      resolve([]);
    }
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

/**
 * A response-like stub satisfying only what dispatchToWorker actually calls on `res`
 * (writeHead/end). Used for background stale-while-revalidate fetches, which need to run
 * the normal dispatch+cache-set path but have no real client waiting on the result.
 */
function createNoopResponse(): http.ServerResponse {
  return {
    writeHead: () => {},
    write: () => true,
    end: () => {},
    destroy: () => {},
    writableEnded: false,
  } as unknown as http.ServerResponse;
}

/**
 * Stale-if-error fallback: before giving up and returning an upstream error to the client,
 * check whether a cacheable GET/HEAD request has a stale-but-still-within-window cached
 * response and serve that instead. Returns true if it served a response (caller must not
 * write its own), false if the caller should proceed with the normal error response.
 */
async function tryServeStaleOnError(
  payload: WorkerMessageType,
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
    // Cache entries always store the body as base64 (binary-safe, unlike the old utf8
    // round-trip) regardless of whether the original response was itself compressed — see
    // the onEnd streaming handler in dispatchToWorker.
    const bodyBuf = Buffer.from(cached.body, "base64");
    res.writeHead(cached.statusCode ?? 200, { ...(cached.headers || {}), "X-Cache": "STALE-ON-ERROR" });
    res.end(payload.requestType === "HEAD" ? undefined : bodyBuf);
    logger.warn("Cache", `Served stale response in place of upstream error (status=${errorStatus})`, { cacheKey });
    return true;
  } catch {
    return false;
  }
}

export async function reloadServerConfig(newConfig: RootConfigType) {
  logger.info("Master", "Hot-reload initiated — rebuilding dependencies and workers");
  ACTIVE_CONFIG = newConfig;
  routeMatcher = new RouteMatcher(ACTIVE_CONFIG.server.paths as RouteRule[]);
  if (ACTIVE_CONFIG.admin.enabled && !ACTIVE_CONFIG.admin.token) {
    logger.warn(
      "Admin",
      "Admin endpoints are enabled but no admin.token/ADMIN_SECRET is configured — all /__* requests will be rejected until a token is set",
    );
  }
  lb = createLoadBalancer({
    strategy: newConfig.server.loadBalancing.strategy,
    upstreams: newConfig.server.upstreams,
    virtualNodes: newConfig.server.loadBalancing.virtualNodes,
    ewmaAlpha: newConfig.server.loadBalancing.ewmaAlpha,
    stickyCookieName: newConfig.server.loadBalancing.stickyCookieName,
    slowStartSeconds: newConfig.server.loadBalancing.slowStartSeconds,
    circuitBreaker: newConfig.server.resilience?.circuitBreaker,
  });
  globalRetryBudget.setBudgetPercent(newConfig.server.resilience?.retry?.budgetPercent ?? 15);
  // Clear old health check interval before hot-reload creates a new LB/config
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = undefined;
  }
  HEALTHY_UPSTREAMS.clear();
  newConfig.server.upstreams.forEach((u) => {
    HEALTHY_UPSTREAMS.add(u.id);
    registry.register({ id: u.id, url: u.url });
  });
  const newConfiguredIds = new Set(newConfig.server.upstreams.map((u) => u.id));
  for (const service of registry.getAll()) {
    if (!newConfiguredIds.has(service.id) && service.metadata?.["dynamic"] !== "true") {
      registry.deregister(service.id);
    }
  }
  if (cache) {
    await cache.disconnect().catch(() => {});
  }
  const effectiveCache = getEffectiveCache(newConfig);
  cache = new Cache({
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
  rateLimiters.clear();
  upstreamBulkheads.clear();
  // Decouple rate-limiter Redis from the cache Redis connection
  const effectiveRateLimit = getEffectiveRateLimit(newConfig);
  const isRedisStorage =
    effectiveRateLimit?.storage === "redis" ||
    newConfig.server.rateLimit?.storage === "redis" ||
    newConfig.server.paths.some((p) => p.rateLimit?.storage === "redis");
  if (isRedisStorage) {
    if (!rlRedisClient) {
      const redisHost =
        effectiveRateLimit?.redis?.host ?? newConfig.server.cache?.host ?? "127.0.0.1";
      const redisPort = effectiveRateLimit?.redis?.port ?? newConfig.server.cache?.port ?? 6379;
      rlRedisClient = createClient({
        socket: { host: redisHost, port: redisPort },
      }) as RedisClientType;
      rlRedisClient.on("error", (err) => logger.error("RateLimiterRedis", err.message));
      await rlRedisClient
        .connect()
        .catch((err) => logger.error("RateLimiterRedis", `Connection failed: ${err.message}`));
      logger.info("RateLimiterRedis", "Connected to Redis for distributed rate limiting");
    }
  }
  if (effectiveRateLimit && effectiveRateLimit.enabled !== false) {
    globalRateLimiter = new RateLimiter({
      windowMs: effectiveRateLimit.windowMs,
      maxRequests: effectiveRateLimit.maxRequests,
      algorithm: effectiveRateLimit.algorithm,
      storage: effectiveRateLimit.storage,
      redisClient: effectiveRateLimit.storage === "redis" ? rlRedisClient : undefined,
      softLimit: effectiveRateLimit.softLimit,
      burstMultiplier: effectiveRateLimit.burstMultiplier,
    });
  } else {
    globalRateLimiter = undefined;
  }
  newConfig.server.paths.forEach((p) => {
    if (p.rateLimit) {
      rateLimiters.set(
        p.path,
        new RateLimiter({
          windowMs: p.rateLimit.windowMs,
          maxRequests: p.rateLimit.maxRequests,
          algorithm: p.rateLimit.algorithm,
          storage: p.rateLimit.storage,
          redisClient: p.rateLimit.storage === "redis" ? rlRedisClient : undefined,
        }),
      );
    }
  });
  if (newConfig.observability?.tenantDelivery?.mode === "webhook") {
    tenantLogStreamer.configure(newConfig.observability.tenantDelivery.exportEndpoints);
  } else {
    tenantLogStreamer.stop();
  }
  const oldWorkers = [...WORKER_POOL];
  WORKER_POOL.length = 0;
  const targetWorkers =
    newConfig.server.workers && newConfig.server.workers > 0
      ? newConfig.server.workers
      : os.cpus().length;
  for (let i = 0; i < targetWorkers; i++) {
    const worker = cluster.fork({
      APP_CONFIG: JSON.stringify(newConfig),
    });
    setupWorkerMessageHandling(worker);
    WORKER_POOL.push(worker);
  }
  broadcastUpstreams();
  logger.info("Master", `Retiring ${oldWorkers.length} old workers`);
  for (const oldWorker of oldWorkers) {
    try {
      oldWorker.send(JSON.stringify({ type: "GRACEFUL_SHUTDOWN" }));
      setTimeout(() => {
        if (!oldWorker.isDead()) {
          oldWorker.kill("SIGTERM");
        }
      }, 15000);
    } catch {}
  }
}
export async function createServer(config: CreateServerConfig) {
  ACTIVE_CONFIG = config.config;
  routeMatcher = new RouteMatcher(ACTIVE_CONFIG.server.paths as RouteRule[]);
  const { port, workerCount } = config;
  ACTIVE_CONFIG.server.upstreams.forEach((e) => HEALTHY_UPSTREAMS.add(e.id));
  if (ACTIVE_CONFIG.admin.enabled && !ACTIVE_CONFIG.admin.token) {
    logger.warn(
      "Admin",
      "Admin endpoints are enabled but no admin.token/ADMIN_SECRET is configured — all /__* requests will be rejected until a token is set",
    );
  }
  if (cluster.isPrimary) {
    const effectiveCache = getEffectiveCache(ACTIVE_CONFIG);
    cache = new Cache({
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
    await cache.connect();
    // Decouple rate-limiter Redis from the cache Redis connection
    const effectiveRateLimit = getEffectiveRateLimit(ACTIVE_CONFIG);
    const isRedisStorage =
      effectiveRateLimit?.storage === "redis" ||
      ACTIVE_CONFIG.server.rateLimit?.storage === "redis" ||
      ACTIVE_CONFIG.server.paths.some((p) => p.rateLimit?.storage === "redis");
    if (isRedisStorage) {
      if (!rlRedisClient) {
        const redisHost =
          effectiveRateLimit?.redis?.host ?? ACTIVE_CONFIG.server.cache?.host ?? "127.0.0.1";
        const redisPort =
          effectiveRateLimit?.redis?.port ?? ACTIVE_CONFIG.server.cache?.port ?? 6379;
        rlRedisClient = createClient({
          socket: { host: redisHost, port: redisPort },
        }) as RedisClientType;
        rlRedisClient.on("error", (err) => logger.error("RateLimiterRedis", err.message));
        await rlRedisClient
          .connect()
          .catch((err) => logger.error("RateLimiterRedis", `Connection failed: ${err.message}`));
        logger.info("RateLimiterRedis", "Connected to Redis for distributed rate limiting");
      }
    }
    if (effectiveRateLimit && effectiveRateLimit.enabled !== false) {
      globalRateLimiter = new RateLimiter({
        windowMs: effectiveRateLimit.windowMs,
        maxRequests: effectiveRateLimit.maxRequests,
        algorithm: effectiveRateLimit.algorithm,
        storage: effectiveRateLimit.storage,
        redisClient: effectiveRateLimit.storage === "redis" ? rlRedisClient : undefined,
        softLimit: effectiveRateLimit.softLimit,
        burstMultiplier: effectiveRateLimit.burstMultiplier,
      });
    } else {
      globalRateLimiter = undefined;
    }
    rateLimiters.clear();
    ACTIVE_CONFIG.server.paths.forEach((p) => {
      if (p.rateLimit) {
        rateLimiters.set(
          p.path,
          new RateLimiter({
            windowMs: p.rateLimit.windowMs,
            maxRequests: p.rateLimit.maxRequests,
            algorithm: p.rateLimit.algorithm,
            storage: p.rateLimit.storage,
            redisClient: p.rateLimit.storage === "redis" ? rlRedisClient : undefined,
          }),
        );
      }
    });
    metricsRegistry = new MetricsRegistry(HEALTHY_UPSTREAMS);
    lb = createLoadBalancer({
      strategy: ACTIVE_CONFIG.server.loadBalancing.strategy,
      upstreams: ACTIVE_CONFIG.server.upstreams,
      virtualNodes: ACTIVE_CONFIG.server.loadBalancing.virtualNodes,
      ewmaAlpha: ACTIVE_CONFIG.server.loadBalancing.ewmaAlpha,
      stickyCookieName: ACTIVE_CONFIG.server.loadBalancing.stickyCookieName,
      slowStartSeconds: ACTIVE_CONFIG.server.loadBalancing.slowStartSeconds,
      circuitBreaker: ACTIVE_CONFIG.server.resilience?.circuitBreaker,
    });
    globalRetryBudget.setBudgetPercent(ACTIVE_CONFIG.server.resilience?.retry?.budgetPercent ?? 15);
    registry.onRegister((service) => {
      HEALTHY_UPSTREAMS.add(service.id);
      lb.addUpstream(service.id, service.url);
      lb.setHealthy(service.id, true);
      broadcastUpstreams();
    });
    registry.onDeregister((service) => {
      HEALTHY_UPSTREAMS.delete(service.id);
      lb.removeUpstream(service.id);
      broadcastUpstreams();
    });
    ACTIVE_CONFIG.server.upstreams.forEach((u) => {
      registry.register({ id: u.id, url: u.url });
    });
    const configuredUpstreamIds = new Set(ACTIVE_CONFIG.server.upstreams.map((u) => u.id));
    for (const service of registry.getAll()) {
      if (!configuredUpstreamIds.has(service.id) && service.metadata?.["dynamic"] !== "true") {
        registry.deregister(service.id);
      }
    }
    let sslOptions: { key: Buffer; cert: Buffer } = { key: Buffer.alloc(0), cert: Buffer.alloc(0) };
    const tlsExplicitlyEnabled = Boolean(
      ACTIVE_CONFIG.tls?.enabled || ACTIVE_CONFIG.server.sslKeyPath,
    );
    try {
      const keyPath =
        ACTIVE_CONFIG.server.sslKeyPath ||
        ACTIVE_CONFIG.tls?.key ||
        (fs.existsSync("/etc/ninja-proxy/certs/key.pem")
          ? "/etc/ninja-proxy/certs/key.pem"
          : "./key.pem");
      const certPath =
        ACTIVE_CONFIG.server.sslCertPath ||
        ACTIVE_CONFIG.tls?.cert ||
        (fs.existsSync("/etc/ninja-proxy/certs/cert.pem")
          ? "/etc/ninja-proxy/certs/cert.pem"
          : "./cert.pem");
      if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        sslOptions = {
          key: readFileSync(keyPath),
          cert: readFileSync(certPath),
        };
      } else if (tlsExplicitlyEnabled) {
        throw new Error(`Certificate files not found: ${keyPath} or ${certPath}`);
      }
    } catch (err: any) {
      if (tlsExplicitlyEnabled) {
        logger.error("Master", `Failed to load TLS certificates: ${err.message}`);
        throw err;
      }
    }
    if (!clusterExitHandlerInstalled) {
      clusterExitHandlerInstalled = true;
      cluster.on("exit", (worker) => {
        if (isShuttingDown) return;
        const idx = WORKER_POOL.indexOf(worker);
        if (idx !== -1) {
          WORKER_POOL.splice(idx, 1);
          const newWorker = cluster.fork({
            APP_CONFIG: JSON.stringify(ACTIVE_CONFIG),
          });
          setupWorkerMessageHandling(newWorker);
          WORKER_POOL.push(newWorker);
          logger.info("Master", `Worker ${worker.id} exited unexpectedly — respawned as worker ${newWorker.id}`);
        }
      });
    }
    if (ACTIVE_CONFIG.observability?.tenantDelivery?.mode === "webhook") {
      tenantLogStreamer.configure(ACTIVE_CONFIG.observability.tenantDelivery.exportEndpoints);
    }
    const effectiveWorkerCount =
      workerCount && workerCount > 0 ? workerCount : os.cpus().length;
    for (let i = 0; i < effectiveWorkerCount; i++) {
      const worker = cluster.fork({
        APP_CONFIG: JSON.stringify(ACTIVE_CONFIG),
      });
      setupWorkerMessageHandling(worker);
      WORKER_POOL.push(worker);
    }
    broadcastUpstreams();
    function dispatchToWorker(
      payload: WorkerMessageType,
      clientIp: string,
      res: http.ServerResponse,
      attempt = 0,
      attemptedUpstreams: Set<string> = new Set(),
      startTime = performance.now(),
      previousSleepMs?: number,
      abortHandle?: AbortHandle,
    ) {
      if (abortHandle?.aborted) {
        // The client was already gone before this attempt (including retries) even started —
        // don't bother picking an upstream or spending a worker/connection slot on it.
        return;
      }
      globalRetryBudget.recordRequest();
      const pathRule = routeMatcher.match(payload.url, payload.requestType);
      const allowedUpstreams = pathRule?.upstream ?? [];
      const routeHealthyUpstreams = new Set(
        [...HEALTHY_UPSTREAMS].filter((id) => allowedUpstreams.includes(id)),
      );
      let upstreamId: string | null = null;
      let routeStage: string | undefined; 
      let setCanaryCookieVal: string | undefined;

      // Canary Deployment Selection (if enabled on this path)
      if (pathRule?.canary?.enabled) {
        const canaryConf = pathRule.canary;
        const canaryId = canaryConf.canaryUpstream;
        const baselineId =
          canaryConf.baselineUpstream || (allowedUpstreams.length > 0 ? allowedUpstreams[0] : null);
        const cookieName = canaryConf.stickyCookieName || "NINJA_CANARY";
        const cookies = parseCookies(payload.headers.cookie);
        const userCookie = cookies[cookieName];

        const isCanaryHealthy = canaryId ? HEALTHY_UPSTREAMS.has(canaryId) : false;
        const canaryBulkhead = canaryId ? upstreamBulkheads.get(canaryId) : undefined;
        const isCanaryAtCapacity = canaryId
          ? lb.isAtCapacity(canaryId, canaryConf.maxConnections) ||
            (canaryBulkhead !== undefined && canaryBulkhead.availableSlots <= 0)
          : false;
        const isCanaryAvailable = isCanaryHealthy && !isCanaryAtCapacity;

        // 1. Header Override (Highest Priority)
        let headerMatched = false;
        if (canaryConf.headerKey && canaryConf.headerValue) {
          const incomingHeaderVal = payload.headers[canaryConf.headerKey.toLowerCase()];
          if (incomingHeaderVal === canaryConf.headerValue) {
            if (isIpAllowed(clientIp, canaryConf.allowedIps)) {
              headerMatched = true;
            } else {
              logger.warn(
                "Canary",
                `Header override ignored for client IP ${clientIp}: not in allowedIps whitelist`,
              );
            }
          }
        }

        if (headerMatched) {
          if (isCanaryAvailable && !attemptedUpstreams.has(canaryId)) {
            upstreamId = canaryId;
            routeStage = canaryConf.stage || "canary";
          } else if (
            baselineId &&
            HEALTHY_UPSTREAMS.has(baselineId) &&
            !attemptedUpstreams.has(baselineId)
          ) {
            logger.warn(
              "Canary",
              `Canary upstream ${canaryId} at capacity; fallback to baseline ${baselineId}`,
            );
            upstreamId = baselineId;
            routeStage = "baseline";
          }
        } else if (userCookie === "canary") {
          if(isCanaryAvailable && !attemptedUpstreams.has(canaryId)) {
            upstreamId = canaryId;
            routeStage = canaryConf.stage || "canary";
          } else if (
            baselineId &&
            HEALTHY_UPSTREAMS.has(baselineId) &&
            !attemptedUpstreams.has(baselineId)
          ) {
            logger.warn(
              "Canary",
              `Canary upstream ${canaryId} at capacity; fallback to baseline ${baselineId}`,
            );
            upstreamId = baselineId;
            routeStage = "baseline";
          }
        } else if (userCookie === "baseline") {
          if (
            baselineId &&
            HEALTHY_UPSTREAMS.has(baselineId) &&
            !attemptedUpstreams.has(baselineId)
          ) {
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
          } else if (
            baselineId &&
            HEALTHY_UPSTREAMS.has(baselineId) &&
            !attemptedUpstreams.has(baselineId)
          ) {
            upstreamId = baselineId;
            routeStage = "baseline";
            setCanaryCookieVal = "baseline";
          }
        }
      }
      if (pathRule?.sticky && !upstreamId) {
        const cookies = parseCookies(payload.headers.cookie);
        const stickId =
          cookies[ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"];
        if (stickId && routeHealthyUpstreams.has(stickId) && !attemptedUpstreams.has(stickId)) {
          upstreamId = stickId;
        }
      }
      if (!upstreamId) {
        const candidateSet =
          routeHealthyUpstreams.size > 0 ? routeHealthyUpstreams : HEALTHY_UPSTREAMS;
        upstreamId = lb.pickFiltered(
          candidateSet,
          clientIp,
          attemptedUpstreams,
          payload.headers.cookie,
        );
        if (!upstreamId && attempt > 0) {
          upstreamId = lb.pickFiltered(candidateSet, clientIp, new Set(), payload.headers.cookie);
        }
      }
      if (!upstreamId) {
        logger.warn("Master", "No healthy upstream available to dispatch request", { attempt });
        void (async () => {
          const servedStale = await tryServeStaleOnError(payload, pathRule, 503, res);
          if (!servedStale) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No healthy upstreams available" }));
          }
          metricsRegistry.recordRequest(
            payload.requestType,
            pathRule?.path ?? "unmatched",
            servedStale ? 200 : 503,
            "none",
            performance.now() - startTime,
          );
        })();
        return;
      }
      attemptedUpstreams.add(upstreamId);
      const effectiveResilience = ACTIVE_CONFIG.resilience ?? ACTIVE_CONFIG.server.resilience;
      const bulkheadConf = effectiveResilience?.bulkhead;
      const isBulkheadEnabled = bulkheadConf?.enabled ?? false;
      if (isBulkheadEnabled) {
        let bulkhead = upstreamBulkheads.get(upstreamId);
        if (!bulkhead) {
          const upstreamConf = ACTIVE_CONFIG.server.upstreams.find((u) => u.id === upstreamId);
          const maxConcurrent =
            bulkheadConf?.maxConcurrentPerUpstream ?? upstreamConf?.maxConnections ?? 1000;
          bulkhead = new Bulkhead(maxConcurrent);
          upstreamBulkheads.set(upstreamId, bulkhead);
        }
        if (!bulkhead.enter()) {
          logger.warn("Resilience", `Bulkhead capacity reached for upstream: ${upstreamId}`);
          // This upstream may have just been selected via a HALF_OPEN circuit-breaker probe
          // grant — but it's being rejected locally (capacity, not health) before ever being
          // contacted, so release that probe slot neutrally rather than leaving it stuck.
          lb.cancelProbe(upstreamId);
          const retryConfig = ACTIVE_CONFIG.server.loadBalancing.retry;
          const retryAllowed = globalRetryBudget.recordRetry();
          if (retryAllowed && attempt < retryConfig.maxAttempts) {
            dispatchToWorker(payload, clientIp, res, attempt + 1, attemptedUpstreams, startTime, undefined, abortHandle);
          } else {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Service unavailable — upstream concurrency limit reached" }),
            );
            metricsRegistry.recordRequest(
              payload.requestType,
              pathRule?.path ?? "unmatched",
              503,
              upstreamId,
              performance.now() - startTime,
            );
          }
          return;
        }
      }
      metricsRegistry.recordActiveConnection(upstreamId, 1);
      lb.incrementConnection(upstreamId);
      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
        upstreamBulkheads.get(upstreamId)?.leave();
        metricsRegistry.recordActiveConnection(upstreamId, -1);
        lb.releaseConnection(upstreamId);
        lb.cancelProbe(upstreamId); // selected, but never actually contacted — see cancelProbe
        res.writeHead(503);
        res.end("Service not found in registry");
        return;
      }
      const forwardHeaders = { ...payload.headers };
      if (pathRule?.canary?.headerKey && pathRule?.canary?.stripHeader !== false) {
        delete forwardHeaders[pathRule.canary.headerKey.toLowerCase()];
      }
      const enrichedPayload = {
        ...payload,
        headers: forwardHeaders,
        upstreamId,
        upstreamUrl: serviceInstance.url,
        clientIp,
      };
      // Per-request routing log removed from the hot path: even gated by minLevel, the
      // template literal above is still constructed as a call argument on every request,
      // and under default (info) log level the synchronous stdout write for each one adds
      // up to measurable event-loop lag under a high-concurrency flood.
      const workerIndex =
        attempt === 0
          ? nextWorkerIndex++ % WORKER_POOL.length
          : (nextWorkerIndex + attempt) % WORKER_POOL.length;
      const worker = WORKER_POOL[workerIndex];
      if (!worker) {
        upstreamBulkheads.get(upstreamId)?.leave();
        metricsRegistry.recordActiveConnection(upstreamId, -1);
        lb.releaseConnection(upstreamId);
        lb.cancelProbe(upstreamId); // selected, but never actually contacted — see cancelProbe
        res.writeHead(500);
        res.end("No worker available");
        return;
      }
      const requestId = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          pendingRequests.delete(requestId);
          upstreamBulkheads.get(upstreamId!)?.leave();
          metricsRegistry.recordActiveConnection(upstreamId!, -1);
          lb.releaseConnection(upstreamId!);
          // A hung request never reaches the resolve() callback below, so without this the
          // circuit breaker never learns about it — worse still, it would leave a half-open
          // trial probe permanently "in flight" and stuck (see REL-02).
          lb.recordFailure(upstreamId!);
          res.writeHead(504);
          res.end("Gateway Timeout");
          metricsRegistry.recordRequest(
            payload.requestType,
            pathRule?.path ?? "unmatched",
            504,
            upstreamId!,
            performance.now() - startTime,
          );
          writeAccessLog(
            ACTIVE_CONFIG.server.accessLog,
            clientIp,
            payload.requestType,
            payload.url,
            504,
            0,
            performance.now() - startTime,
            (payload.headers["user-agent"] as string) ?? "-",
          );
        }
      }, ACTIVE_CONFIG.server.readTimeoutMs);
      if (abortHandle) {
        abortHandle.requestId = requestId;
        abortHandle.worker = worker;
      }
      // Accumulated across the onHeaders/onChunk/onEnd callbacks below for this one attempt.
      const streamState: {
        statusCode?: number;
        replyHeaders?: any;
        isCacheMethod: boolean;
        isCacheable: boolean;
        cacheChunks?: Buffer[];
        totalBytes: number;
      } = { isCacheMethod: false, isCacheable: false, totalBytes: 0 };
      pendingRequests.set(requestId, {
        timer,
        upstreamId,
        startTime,
        payload,
        clientIp,
        res,
        worker,
        resolve: async (rawReply: any) => {
          const reply = await workerMessageReplySchema.parseAsync(rawReply);
          const retryConfig = ACTIVE_CONFIG.server.loadBalancing.retry;
          const errorStatus = reply.statusCode ?? 502;
          const isRetryable =
            (reply.errorCode && reply.errorCode !== "404") ||
            (reply.statusCode && retryConfig.statusCodes.includes(reply.statusCode));
          if (reply.errorCode === "404") {
            // The worker found no route matching this path/method (e.g. a method-guarded
            // route rejecting this verb). No amount of retrying changes that — it's a
            // routing mismatch, not a transient upstream failure — so fail fast with the
            // real status instead of burning retry attempts and surfacing a misleading 502.
            upstreamBulkheads.get(upstreamId!)?.leave();
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            lb.releaseConnection(upstreamId!);
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: reply.error || "Route not found" }));
          } else if (isRetryable) {
            logger.warn(
              "Master",
              `Upstream failure: errorCode=${reply.errorCode}, status=${reply.statusCode}`,
              { upstreamId },
            );
            lb.recordFailure(upstreamId!);
            passiveProbe.record({
              upstreamId: upstreamId!,
              statusCode: errorStatus,
              latencyMs: performance.now() - startTime,
            });
            const isLocalFailure = errorStatus === 500 || errorStatus === 502;
            const resilienceRetryConf = effectiveResilience?.retry;
            const policyAllowsRetry = isLocalFailure
              ? (resilienceRetryConf?.retryOn?.localNodeFailure ?? true)
              : (resilienceRetryConf?.retryOn?.systemOverload ?? true);
            const methodRetrySafe = isMethodRetrySafe(
              payload.requestType,
              payload.headers,
              resilienceRetryConf?.retryMutatingMethods ?? false,
            );
            const retryAllowed =
              policyAllowsRetry && methodRetrySafe && globalRetryBudget.recordRetry();
            if (retryAllowed && attempt < retryConfig.maxAttempts) {
              if (isLocalFailure) {
                upstreamBulkheads.get(upstreamId!)?.leave();
                metricsRegistry.recordActiveConnection(upstreamId!, -1);
                lb.releaseConnection(upstreamId!);
                dispatchToWorker(
                  payload,
                  clientIp,
                  res,
                  attempt + 1,
                  attemptedUpstreams,
                  startTime,
                  undefined,
                  abortHandle,
                );
              } else {
                const retryConf = ACTIVE_CONFIG.server.resilience?.retry;
                const baseDelayMs = retryConf?.baseDelayMs ?? 100;
                const maxDelayMs = retryConf?.maxDelayMs ?? 5000;
                const backoffType = retryConf?.backoff ?? "full-jitter";
                let jitterDelay: number;
                switch (backoffType) {
                  case "exponential":
                    jitterDelay = calculateExponentialBackoff(attempt, baseDelayMs, maxDelayMs);
                    break;
                  case "equal-jitter":
                    jitterDelay = calculateEqualJitterBackoff(attempt, baseDelayMs, maxDelayMs);
                    break;
                  case "decorrelated-jitter":
                    jitterDelay = calculateDecorrelatedJitterBackoff(
                      attempt,
                      baseDelayMs,
                      maxDelayMs,
                      previousSleepMs,
                    );
                    break;
                  case "full-jitter":
                  default:
                    jitterDelay = calculateFullJitterBackoff(attempt, baseDelayMs, maxDelayMs);
                    break;
                }
                logger.warn(
                  "Master",
                  `Backing off (${backoffType}) for ${Math.round(jitterDelay)}ms before retry`,
                );
                setTimeout(() => {
                  upstreamBulkheads.get(upstreamId!)?.leave();
                  metricsRegistry.recordActiveConnection(upstreamId!, -1);
                  lb.releaseConnection(upstreamId!);
                  dispatchToWorker(
                    payload,
                    clientIp,
                    res,
                    attempt + 1,
                    attemptedUpstreams,
                    startTime,
                    jitterDelay,
                    abortHandle,
                  );
                }, jitterDelay);
              }
            } else {
              if (!retryAllowed) {
                const reason = !methodRetrySafe
                  ? `non-idempotent method (${payload.requestType}) without Idempotency-Key`
                  : !policyAllowsRetry
                    ? "disabled via resilience.retry.retryOn policy"
                    : "retry budget exhausted — dropping retry to protect backend from retry storm";
                logger.warn("Master", `Retry not attempted: ${reason}`, { upstreamId });
              }
              upstreamBulkheads.get(upstreamId!)?.leave();
              metricsRegistry.recordActiveConnection(upstreamId!, -1);
              lb.releaseConnection(upstreamId!);
              void (async () => {
                const servedStale = await tryServeStaleOnError(payload, pathRule, errorStatus, res);
                if (!servedStale) {
                  res.writeHead(errorStatus);
                  res.end(reply.error || "Bad Gateway");
                }
              })();
            }
          } else if (reply.statusCode && reply.statusCode >= 500) {
            // A plain (non-connection-level) 5xx isn't in retryConfig.statusCodes by default,
            // so it lands here rather than in the isRetryable branch above — still worth a
            // stale-if-error check before relaying the error, for a cacheable GET/HEAD.
            lb.recordFailure(upstreamId!);
            passiveProbe.record({
              upstreamId: upstreamId!,
              statusCode: reply.statusCode,
              latencyMs: performance.now() - startTime,
            });
            upstreamBulkheads.get(upstreamId!)?.leave();
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            lb.releaseConnection(upstreamId!);
            void (async () => {
              const servedStale = await tryServeStaleOnError(payload, pathRule, reply.statusCode!, res);
              if (!servedStale) {
                res.writeHead(reply.statusCode!, { "Content-Type": "application/json" });
                res.end(reply.data || "Internal Server Error");
              }
            })();
          } else {
            let responseData: Buffer | string = reply.data;
            if (reply.isCompressed && reply.encoding === "gzip") {
              responseData = Buffer.from(reply.data, "base64");
            }
            const latencyMs = performance.now() - startTime;
            // reply.data (when still a string here) is worker.ts's binary-safe latin1
            // encoding, not utf8 — Buffer.byteLength must match or it miscounts any byte >=
            // 0x80.
            const responseBytes =
              typeof responseData === "string"
                ? Buffer.byteLength(responseData, "binary")
                : responseData.length;
            lb.recordSuccess(upstreamId!, latencyMs);
            passiveProbe.record({
              upstreamId: upstreamId!,
              statusCode: reply.statusCode ?? 200,
              latencyMs,
            });
            upstreamBulkheads.get(upstreamId!)?.leave();
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            lb.releaseConnection(upstreamId!);
            const isCacheMethod = payload.requestType === "GET" || payload.requestType === "HEAD";
            if (isCacheMethod) {
              metricsRegistry.recordCacheOp("miss");
            }
            const hasSetCookie = !!reply.headers?.["set-cookie"];
            const effectiveCache = getEffectiveCache(ACTIVE_CONFIG);
            const isCacheable =
              (reply.statusCode === 200 || reply.statusCode === 301) &&
              !payload.headers["authorization"] &&
              !hasSetCookie &&
              pathRule?.cache?.enabled !== false &&
              cache.isResponseCacheable(reply.headers);
            if (isCacheable && isCacheMethod) {
              const parsedUrl = new URL(payload.url, "http://dummy");
              const cacheKey = cache.buildKey(
                payload.requestType,
                parsedUrl.pathname + parsedUrl.search,
                payload.headers,
              );
              const maxAgeSeconds = pathRule?.cache?.ttlSeconds ?? effectiveCache.ttlSeconds;
              // Physical TTL outlives the logical max-age so stale-while-revalidate and
              // stale-if-error have an entry left to serve once it's past maxAgeSeconds.
              const physicalTtlSeconds = maxAgeSeconds + (effectiveCache.staleIfErrorSeconds ?? 86400);
              const cachePayload = JSON.stringify({
                statusCode: reply.statusCode ?? 200,
                headers: reply.headers ?? {},
                body: reply.data,
                isCompressed: reply.isCompressed ?? false,
                encoding: reply.encoding,
                storedAt: Date.now(),
                maxAgeSeconds,
              });
              const tagHeader = reply.headers?.["cache-tag"] ?? reply.headers?.["x-cache-tags"];
              const tags = tagHeader
                ? (Array.isArray(tagHeader) ? tagHeader.join(",") : String(tagHeader))
                    .split(",")
                    .map((t: string) => t.trim())
                    .filter(Boolean)
                : undefined;
              await cache.set(cacheKey, cachePayload, physicalTtlSeconds, tags);
            }
            const responseHeaders: Record<string, any> = {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Credentials": "true",
              "X-Upstream-Id": upstreamId,
              ...(reply.headers || {}),
            };
            if (effectiveCache?.enabled && isCacheMethod) {
              responseHeaders["X-Cache"] = "MISS";
            }
            delete responseHeaders["content-length"];
            delete responseHeaders["transfer-encoding"];
            delete responseHeaders["connection"];
            if (routeStage) {
              responseHeaders["X-Route-Stage"] = routeStage;
            }
            const setCookieList: string[] = [];
            const upstreamSetCookie = reply.headers?.["set-cookie"];
            if (upstreamSetCookie) {
              if (Array.isArray(upstreamSetCookie)) {
                setCookieList.push(...upstreamSetCookie);
              } else {
                setCookieList.push(upstreamSetCookie);
              }
            }
            if (pathRule?.sticky) {
              const maxAge = ACTIVE_CONFIG.server.loadBalancing.stickyCookieTtlMs
                ? `; Max-Age=${Math.round(ACTIVE_CONFIG.server.loadBalancing.stickyCookieTtlMs / 1000)}`
                : "";
              setCookieList.push(
                `${ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"}=${upstreamId}; Path=/; HttpOnly; SameSite=Lax${maxAge}`,
              );
            }
            if (setCanaryCookieVal && pathRule?.canary) {
              const cName = pathRule.canary.stickyCookieName || "NINJA_CANARY";
              setCookieList.push(`${cName}=${setCanaryCookieVal}; Path=/; HttpOnly; SameSite=Lax`);
            }
            if (setCookieList.length > 0) {
              responseHeaders["Set-Cookie"] =
                setCookieList.length === 1 ? setCookieList[0] : setCookieList;
            }
            res.writeHead(reply.statusCode ?? 200, responseHeaders);
            // responseData (when still a string) is worker.ts's binary-safe latin1 encoding —
            // must be written back with the matching encoding or high bytes get corrupted by
            // Node's default utf8 write encoding.
            if (typeof responseData === "string") res.end(responseData, "binary");
            else res.end(responseData);
            // Access log is written by the worker process
          }
        },
        onHeaders: (headersReply: HttpReplyHeadersType) => {
          const isCacheMethod = payload.requestType === "GET" || payload.requestType === "HEAD";
          const hasSetCookie = !!headersReply.headers?.["set-cookie"];
          const effectiveCache = getEffectiveCache(ACTIVE_CONFIG);
          const isCacheable =
            (headersReply.statusCode === 200 || headersReply.statusCode === 301) &&
            !payload.headers["authorization"] &&
            !hasSetCookie &&
            pathRule?.cache?.enabled !== false &&
            cache.isResponseCacheable(headersReply.headers);

          streamState.statusCode = headersReply.statusCode;
          streamState.replyHeaders = headersReply.headers;
          streamState.isCacheMethod = isCacheMethod;
          streamState.isCacheable = isCacheable && isCacheMethod;
          if (streamState.isCacheable) streamState.cacheChunks = [];

          const responseHeaders: Record<string, any> = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Credentials": "true",
            "X-Upstream-Id": upstreamId,
            ...(headersReply.headers || {}),
          };
          if (effectiveCache?.enabled && isCacheMethod) {
            responseHeaders["X-Cache"] = "MISS";
          }
          delete responseHeaders["transfer-encoding"];
          delete responseHeaders["connection"];
          if (routeStage) {
            responseHeaders["X-Route-Stage"] = routeStage;
          }
          const setCookieList: string[] = [];
          const upstreamSetCookie = headersReply.headers?.["set-cookie"];
          if (upstreamSetCookie) {
            if (Array.isArray(upstreamSetCookie)) setCookieList.push(...upstreamSetCookie);
            else setCookieList.push(upstreamSetCookie);
          }
          if (pathRule?.sticky) {
            const maxAge = ACTIVE_CONFIG.server.loadBalancing.stickyCookieTtlMs
              ? `; Max-Age=${Math.round(ACTIVE_CONFIG.server.loadBalancing.stickyCookieTtlMs / 1000)}`
              : "";
            setCookieList.push(
              `${ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"}=${upstreamId}; Path=/; HttpOnly; SameSite=Lax${maxAge}`,
            );
          }
          if (setCanaryCookieVal && pathRule?.canary) {
            const cName = pathRule.canary.stickyCookieName || "NINJA_CANARY";
            setCookieList.push(`${cName}=${setCanaryCookieVal}; Path=/; HttpOnly; SameSite=Lax`);
          }
          if (setCookieList.length > 0) {
            responseHeaders["Set-Cookie"] = setCookieList.length === 1 ? setCookieList[0] : setCookieList;
          }
          res.writeHead(headersReply.statusCode ?? 200, responseHeaders);
        },
        onChunk: (chunkReply: HttpReplyChunkType) => {
          const buf = Buffer.from(chunkReply.data, "base64");
          streamState.totalBytes += buf.length;
          if (streamState.cacheChunks) streamState.cacheChunks.push(buf);
          if (!res.writableEnded) res.write(buf);
        },
        onEnd: () => {
          void (async () => {
            const latencyMs = performance.now() - startTime;
            lb.recordSuccess(upstreamId!, latencyMs);
            passiveProbe.record({
              upstreamId: upstreamId!,
              statusCode: streamState.statusCode ?? 200,
              latencyMs,
            });
            upstreamBulkheads.get(upstreamId!)?.leave();
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            lb.releaseConnection(upstreamId!);
            if (streamState.isCacheMethod) {
              metricsRegistry.recordCacheOp("miss");
            }
            if (streamState.isCacheable && streamState.cacheChunks) {
              const effectiveCache = getEffectiveCache(ACTIVE_CONFIG);
              const parsedUrl = new URL(payload.url, "http://dummy");
              const cacheKey = cache.buildKey(
                payload.requestType,
                parsedUrl.pathname + parsedUrl.search,
                payload.headers,
              );
              const maxAgeSeconds = pathRule?.cache?.ttlSeconds ?? effectiveCache.ttlSeconds;
              const physicalTtlSeconds = maxAgeSeconds + (effectiveCache.staleIfErrorSeconds ?? 86400);
              const bodyBuffer = Buffer.concat(streamState.cacheChunks);
              const cachePayload = JSON.stringify({
                statusCode: streamState.statusCode ?? 200,
                headers: streamState.replyHeaders ?? {},
                // Always base64 — binary-safe regardless of what the response content was.
                body: bodyBuffer.toString("base64"),
                storedAt: Date.now(),
                maxAgeSeconds,
              });
              const tagHeader =
                streamState.replyHeaders?.["cache-tag"] ?? streamState.replyHeaders?.["x-cache-tags"];
              const tags = tagHeader
                ? (Array.isArray(tagHeader) ? tagHeader.join(",") : String(tagHeader))
                    .split(",")
                    .map((t: string) => t.trim())
                    .filter(Boolean)
                : undefined;
              await cache.set(cacheKey, cachePayload, physicalTtlSeconds, tags);
            }
            if (!res.writableEnded) res.end();
          })();
        },
        onAbort: (abortReply: HttpReplyAbortType) => {
          logger.error(
            "Master",
            `Upstream response aborted mid-stream: ${abortReply.reason ?? "unknown"}`,
            { upstreamId },
          );
          lb.recordFailure(upstreamId!);
          passiveProbe.record({
            upstreamId: upstreamId!,
            statusCode: 502,
            latencyMs: performance.now() - startTime,
          });
          upstreamBulkheads.get(upstreamId!)?.leave();
          metricsRegistry.recordActiveConnection(upstreamId!, -1);
          lb.releaseConnection(upstreamId!);
          try {
            res.destroy();
          } catch {}
        },
      });
      // Use backpressure-safe workerSend: if the IPC pipe's write buffer is full
      // (worker.send() returns false), the message is queued and flushed via setImmediate
      // instead of being silently dropped. Deferred one tick via the outer setImmediate so
      // building this specific payload's JSON string doesn't run back-to-back with every
      // other concurrent request's synchronous work in the same turn of the event loop —
      // spreading the per-request serialization cost across more turns under a flood,
      // rather than one long unbroken synchronous chain starving the loop.
      setImmediate(() => {
        workerSend(
          worker,
          JSON.stringify({
            ...enrichedPayload,
            requestId,
          }),
        );
      });
    }
    let httpServer!: http.Server;
    const wsUpgradeHandler = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const pathRule = routeMatcher.match(url.pathname, req.method);
      if (!pathRule) {
        socket.destroy();
        return;
      }
      const clientIP = resolveClientIp(req, socket, {
        trustProxy: ACTIVE_CONFIG.server.trustProxy,
        trustedProxies: ACTIVE_CONFIG.server.trustedProxies,
      });
      const allowedUpstreams = pathRule?.upstream ?? [];
      const routeHealthyUpstreams = new Set(
        [...HEALTHY_UPSTREAMS].filter((id) => allowedUpstreams.includes(id)),
      );

      let upstreamId: string | null = null;
      if (pathRule?.canary?.enabled) {
        const canaryConf = pathRule.canary;
        const canaryId = canaryConf.canaryUpstream;
        const baselineId =
          canaryConf.baselineUpstream || (allowedUpstreams.length > 0 ? allowedUpstreams[0] : null);
        const cookieName = canaryConf.stickyCookieName || "NINJA_CANARY";
        const cookies = parseCookies(req.headers.cookie);
        const userCookie = cookies[cookieName];
        const isCanaryHealthy = canaryId ? HEALTHY_UPSTREAMS.has(canaryId) : false;
        const canaryBulkhead = canaryId ? upstreamBulkheads.get(canaryId) : undefined;
        const isCanaryAtCapacity = canaryId
          ? lb.isAtCapacity(canaryId, canaryConf.maxConnections) ||
            (canaryBulkhead !== undefined && canaryBulkhead.availableSlots <= 0)
          : false;
        const isCanaryAvailable = isCanaryHealthy && !isCanaryAtCapacity;

        let headerMatched = false;
        if (canaryConf.headerKey && canaryConf.headerValue) {
          const incomingHeaderVal = req.headers[canaryConf.headerKey.toLowerCase()];
          if (incomingHeaderVal === canaryConf.headerValue) {
            if (isIpAllowed(clientIP, canaryConf.allowedIps)) {
              headerMatched = true;
            } else {
              logger.warn(
                "Canary",
                `WS Header override ignored for client IP ${clientIP}: not in allowedIps whitelist`,
              );
            }
          }
        }

        if (headerMatched) {
          if (isCanaryAvailable) {
            upstreamId = canaryId;
          } else if (baselineId && HEALTHY_UPSTREAMS.has(baselineId)) {
            logger.warn(
              "Canary",
              `WS Canary upstream ${canaryId} at capacity; fallback to baseline ${baselineId}`,
            );
            upstreamId = baselineId;
          }
        } else if (userCookie === "canary") {
          if (isCanaryAvailable) {
            upstreamId = canaryId;
          } else if (baselineId && HEALTHY_UPSTREAMS.has(baselineId)) {
            logger.warn(
              "Canary",
              `WS Canary upstream ${canaryId} at capacity; fallback to baseline ${baselineId}`,
            );
            upstreamId = baselineId;
          }
        } else if (userCookie === "baseline" && baselineId && HEALTHY_UPSTREAMS.has(baselineId)) {
          upstreamId = baselineId;
        } else {
          const weight = canaryConf.weight ?? 10;
          if (Math.random() * 100 < weight && isCanaryAvailable) {
            upstreamId = canaryId;
          } else if (baselineId && HEALTHY_UPSTREAMS.has(baselineId)) {
            upstreamId = baselineId;
          }
        }
      }

      if (pathRule?.sticky && !upstreamId) {
        const cookies = parseCookies(req.headers.cookie);
        const stickId =
          cookies[ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"];
        if (stickId && routeHealthyUpstreams.has(stickId)) {
          upstreamId = stickId;
        }
      }
      if (!upstreamId) {
        upstreamId = lb.pickFiltered(
          routeHealthyUpstreams.size > 0 ? routeHealthyUpstreams : HEALTHY_UPSTREAMS,
          clientIP,
          new Set(),
          req.headers.cookie,
        );
      }
      if (!upstreamId) {
        socket.destroy();
        return;
      }
      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
        lb.cancelProbe(upstreamId); // selected via pickFiltered, but never actually contacted
        socket.destroy();
        return;
      }
      if (WORKER_POOL.length === 0) {
        lb.cancelProbe(upstreamId);
        socket.destroy();
        return;
      }
      const workerIndex = Math.floor(Math.random() * WORKER_POOL.length);
      const worker = WORKER_POOL[workerIndex];
      if (!worker) {
        lb.cancelProbe(upstreamId);
        socket.destroy();
        return;
      }
      const outgoingHeaders = { ...req.headers };
      if (pathRule?.canary?.headerKey && pathRule?.canary?.stripHeader !== false) {
        delete outgoingHeaders[pathRule.canary.headerKey.toLowerCase()];
      }
      const reqFields = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        httpVersion: req.httpVersion,
        headers: outgoingHeaders,
      };
      const payload = {
        type: "WEBSOCKET_UPGRADE",
        reqFields,
        upstreamId,
        upstreamUrl: serviceInstance.url,
        head: head.toString("base64"),
      };
      lb.incrementConnection(upstreamId);
      metricsRegistry.recordActiveConnection(upstreamId, 1);

      if (socket instanceof tls.TLSSocket) {
        const upstreamStaticConfig = ACTIVE_CONFIG.server.upstreams.find(
          (u) => u.id === upstreamId,
        );
        const tlsConfig = upstreamStaticConfig?.tls;
        tunnelWebSocket(socket, serviceInstance.url, reqFields, head, tlsConfig, () => {
          lb.releaseConnection(upstreamId);
          metricsRegistry.recordActiveConnection(upstreamId, -1);
        });
        return;
      }

      try {
        worker.send(JSON.stringify(payload), socket);
        socket.pause();
        socket.removeAllListeners();
      } catch (err: any) {
        logger.error(
          "Master",
          `Failed to send socket to worker: ${err.message}, tunneling directly in master`,
        );
        tunnelWebSocket(socket, serviceInstance.url, reqFields, head, undefined, () => {
          lb.releaseConnection(upstreamId);
          metricsRegistry.recordActiveConnection(upstreamId, -1);
        });
      }
    };
    let httpsServer: https.Server | undefined;
    const proxyRequestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // 1. Admin and monitoring endpoints
      const isAdmin = await handleAdminRequest({
        req,
        res,
        config: ACTIVE_CONFIG,
        lb,
        healthyUpstreams: HEALTHY_UPSTREAMS,
        retryBudget: globalRetryBudget,
        metricsRegistry,
        cache,
        collectWorkerMetricSnapshots,
      });
      if (isAdmin) return;

      // 2. Request context & middleware pipeline
      const ctx = createContext(req, res, {
        trustProxy: ACTIVE_CONFIG.server.trustProxy,
        trustedProxies: ACTIVE_CONFIG.server.trustedProxies,
      });
      const pipeline = new MiddlewarePipeline();

      // CORS middleware
      pipeline.use(corsMiddleware());

      // Tracing middleware
      pipeline.use(tracingMiddleware());

      // Body limit middleware (10MB limit)
      pipeline.use(bodyLimitMiddleware(MAX_REQUEST_BODY_BYTES));

      // Auth middleware — enforced only for routes with a configured auth.tokens list
      pipeline.use(async (c, next) => {
        const url = new URL(c.req.url!, `https://${c.req.headers.host}`);
        const pathRule = routeMatcher.match(url.pathname, c.req.method);
        if (pathRule?.auth?.tokens && pathRule.auth.tokens.length > 0) {
          const guard = authMiddleware(new Set(pathRule.auth.tokens));
          await guard(c, next);
        } else {
          await next();
        }
      });

      // Rate limiting middleware
      pipeline.use(async (c, next) => {
        const clientIP = c.clientIp;
        const url = new URL(c.req.url!, `https://${c.req.headers.host}`);
        const pathRule = routeMatcher.match(url.pathname, c.req.method);

        // Global Rate Limiter Check
        const effectiveGlobalRateLimit = getEffectiveRateLimit(ACTIVE_CONFIG);
        if (
          globalRateLimiter &&
          effectiveGlobalRateLimit &&
          effectiveGlobalRateLimit.enabled !== false
        ) {
          const allowed = await globalRateLimiter.isAllowed(clientIP);
          const algoState = await globalRateLimiter.getAlgorithmState(clientIP);
          if (!allowed) {
            logger.warn(
              "RateLimit",
              `BLOCKED ${clientIP} via [${globalRateLimiter.getAlgorithm()}]`,
              { ...algoState, limit: effectiveGlobalRateLimit.maxRequests },
            );
            const retryAfter = Math.ceil(
              (globalRateLimiter.getResetTime(clientIP) - Date.now()) / 1000,
            );
            c.res.writeHead(429, {
              "Content-Type": "application/json",
              "Retry-After": retryAfter.toString(),
              "X-RateLimit-Scope": "global",
              "X-RateLimit-Limit": effectiveGlobalRateLimit.maxRequests.toString(),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": globalRateLimiter.getResetTime(clientIP).toString(),
              "X-RateLimit-Algorithm": globalRateLimiter.getAlgorithm(),
            });
            const tenantId = (c.req.headers["x-tenant-id"] as string) ?? "none";
            metricsRegistry.recordRequest(
              c.req.method ?? "GET",
              pathRule?.path ?? "unmatched",
              429,
              "rate-limiter",
              0,
              tenantId,
            );
            c.res.end(
              JSON.stringify({
                error: "Too Many Requests",
                scope: "global",
                algorithm: globalRateLimiter.getAlgorithm(),
                state: algoState,
                retryAfter: `${retryAfter}s`,
              }),
            );
            return;
          } else {
            logger.info(
              "RateLimit",
              `ALLOWED ${clientIP} via [${globalRateLimiter.getAlgorithm()}]`,
              { ...algoState, limit: effectiveGlobalRateLimit.maxRequests },
            );
          }
        }

        // Route-Level Rate Limiter Check
        if (pathRule?.rateLimit) {
          const routeLimiter = rateLimiters.get(pathRule.path);
          if (routeLimiter && !(await routeLimiter.isAllowed(clientIP))) {
            const retryAfter = Math.ceil((routeLimiter.getResetTime(clientIP) - Date.now()) / 1000);
            c.res.writeHead(429, {
              "Content-Type": "application/json",
              "Retry-After": retryAfter.toString(),
              "X-RateLimit-Scope": "route",
              "X-RateLimit-Limit": pathRule.rateLimit.maxRequests.toString(),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": routeLimiter.getResetTime(clientIP).toString(),
              "X-RateLimit-Algorithm": routeLimiter.getAlgorithm(),
            });
            const tenantId = (c.req.headers["x-tenant-id"] as string) ?? "none";
            metricsRegistry.recordRequest(
              c.req.method ?? "GET",
              pathRule?.path ?? "unmatched",
              429,
              "rate-limiter",
              0,
              tenantId,
            );
            c.res.end(
              JSON.stringify({
                error: "Too Many Requests",
                scope: "route",
                retryAfter: `${retryAfter}s`,
                algorithm: routeLimiter.getAlgorithm(),
              }),
            );
            return;
          }
        }
        await next();
      });

      // Cache middleware
      pipeline.use(async (c, next) => {
        const clientIP = c.clientIp;
        const url = new URL(c.req.url!, `https://${c.req.headers.host}`);
        const pathRule = routeMatcher.match(url.pathname, c.req.method);

        if (c.req.method === "GET" || c.req.method === "HEAD") {
          const skipCache =
            url.pathname.startsWith("/api/upload/") || pathRule?.cache?.enabled === false;
          if (!skipCache) {
            const cacheKey = cache.buildKey(c.req.method ?? "GET", url.pathname + url.search, c.req.headers);
            const cachedJson = await cache.get(cacheKey);
            if (cachedJson) {
              try {
                const cached = JSON.parse(cachedJson);
                const ageSeconds = cached.storedAt ? (Date.now() - cached.storedAt) / 1000 : Infinity;
                const maxAgeSeconds = cached.maxAgeSeconds ?? getEffectiveCache(ACTIVE_CONFIG).ttlSeconds;
                const isFresh = ageSeconds <= maxAgeSeconds;
                const canServeStale = !isFresh && cache.shouldRevalidate(cacheKey, ageSeconds, maxAgeSeconds);
                if (isFresh || canServeStale) {
                  c.res.writeHead(cached.statusCode ?? 200, {
                    ...(cached.headers || {}),
                    "X-Cache": isFresh ? "HIT" : "STALE",
                  });
                  // Cache entries always store the body as base64 (binary-safe) regardless of
                  // whether the original response was itself compressed — see the onEnd
                  // streaming handler in dispatchToWorker.
                  const bodyBuf = Buffer.from(cached.body, "base64");
                  if (c.req.method === "HEAD") {
                    c.res.end();
                  } else {
                    c.res.end(bodyBuf);
                  }
                  const tenantId = (c.req.headers["x-tenant-id"] as string) ?? "none";
                  metricsRegistry.recordCacheOp("hit");
                  metricsRegistry.recordRequest(
                    c.req.method,
                    pathRule?.path ?? "unmatched",
                    cached.statusCode ?? 200,
                    "cache",
                    0,
                    tenantId,
                  );
                  writeAccessLog(
                    ACTIVE_CONFIG.server.accessLog,
                    clientIP,
                    c.req.method,
                    c.req.url ?? "",
                    cached.statusCode ?? 200,
                    c.req.method === "HEAD" ? 0 : Buffer.byteLength(bodyBuf),
                    0,
                    (c.req.headers["user-agent"] as string) ?? "-",
                  );
                  if (ACTIVE_CONFIG.observability?.tenantDelivery?.mode === "webhook") {
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
                    // Stale-while-revalidate: the client already has a response — refresh the
                    // cache in the background via a dispatch whose "response" nobody reads.
                    cache.markRevalidating(cacheKey);
                    const revalidatePayload: WorkerMessageType = {
                      requestType: c.req.method ?? "GET",
                      headers: c.req.headers,
                      body: null,
                      url: `${c.req.url}`,
                    };
                    dispatchToWorker(revalidatePayload, clientIP, createNoopResponse());
                    setTimeout(
                      () => cache.markRevalidationDone(cacheKey),
                      (ACTIVE_CONFIG.server.readTimeoutMs ?? 15000) + 2000,
                    ).unref();
                  }
                  return;
                }
                // Stale, and either SWR is disabled or a revalidation is already in flight —
                // fall through to a normal dispatch below, which will refresh the entry.
              } catch {
                // fallback if cache corrupt
              }
            }
          }
        }

        if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method ?? "")) {
          await cache.invalidate(url.pathname);
        }

        await next();
      });

      // Dispatch to worker
      pipeline.use(async (c) => {
        const clientIP = c.clientIp;
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let rejected = false;

        // If the client disconnects while the upstream is still streaming (or before it even
        // starts), don't leave that upstream request running to completion for nobody — abort
        // it on the worker side and release every resource (bulkhead slot, connection count,
        // circuit-breaker half-open probe slot) it was holding.
        // Note: this listens on the *response* object's 'close', not the request's. Node
        // fires req.on('close') once the request body has been fully read — effectively
        // immediately for a bodyless GET — which is unrelated to whether the connection
        // dropped before a response went out. res.on('close') is the one that actually means
        // "the underlying connection was terminated before res.end() completed."
        const abortHandle: AbortHandle = { aborted: false };
        c.res.on("close", () => {
          if (c.res.writableEnded) return; // normal completion, not an abort
          abortHandle.aborted = true;
          if (abortHandle.requestId && abortHandle.worker) {
            try {
              workerSend(abortHandle.worker, JSON.stringify({ type: "ABORT_REQUEST", requestId: abortHandle.requestId }));
            } catch {}
          }
          const pending = abortHandle.requestId ? pendingRequests.get(abortHandle.requestId) : undefined;
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(abortHandle.requestId!);
            upstreamBulkheads.get(pending.upstreamId)?.leave();
            metricsRegistry.recordActiveConnection(pending.upstreamId, -1);
            // A client hanging up mid-request says nothing about the upstream's health — it
            // may have been about to answer perfectly fine. recordAbort releases the
            // connection slot and any held HALF_OPEN probe slot (so it isn't stuck until the
            // breaker's own recovery window expires) without counting a failure, so a run of
            // impatient clients can never trip the breaker for every other tenant sharing this
            // upstream.
            lb.recordAbort(pending.upstreamId);
            logger.warn(
              "Master",
              "Client disconnected before response completed — aborted in-flight upstream request",
              { upstreamId: pending.upstreamId },
            );
          }
        });

        const sendPayload = (bodyBuffer: Buffer) => {
          const body = bodyBuffer.length > 0 ? bodyBuffer.toString("binary") : null;
          const payload: WorkerMessageType = {
            requestType: c.req.method ?? "GET",
            headers: c.req.headers,
            body: body,
            url: `${c.req.url}`,
          };
          dispatchToWorker(payload, clientIP, c.res, 0, new Set(), performance.now(), undefined, abortHandle);
        };

        if (c.req.readableEnded) {
          sendPayload(Buffer.concat(chunks));
          return;
        }

        c.req.on("data", (chunk: Buffer) => {
          if (rejected) return;
          receivedBytes += chunk.length;
          // Enforced here regardless of Content-Length, which a client can omit (chunked
          // transfer-encoding) or understate — bodyLimitMiddleware's header check alone is
          // trivially bypassable and only catches the honest case.
          if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
            rejected = true;
            c.req.destroy();
            if (!c.res.writableEnded) {
              c.res.writeHead(413, { "Content-Type": "application/json" });
              c.res.end(JSON.stringify({ error: "Payload Too Large" }));
            }
            return;
          }
          chunks.push(chunk);
        });
        c.req.on("end", () => {
          if (rejected) return;
          sendPayload(Buffer.concat(chunks));
        });
      });

      await pipeline.run(ctx);
    };

    const isTlsEnabled = Boolean(ACTIVE_CONFIG.tls?.enabled && sslOptions.key.length > 0);
    if (isTlsEnabled) {
      httpsServer = https.createServer(
        sslOptions,
        (req, res) => void proxyRequestHandler(req, res),
      );
      httpsServer.on("upgrade", wsUpgradeHandler);

      if (ACTIVE_CONFIG.tls?.redirectHttp ?? true) {
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
          const httpsUrl = `https://${req.headers.host?.replace(
            String(port),
            String(ACTIVE_CONFIG.tls?.httpsPort ?? ACTIVE_CONFIG.server.httpsPort ?? 8443),
          )}${req.url}`;
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
    async function gracefulShutdown(signal: string) {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info("Master", `Received ${signal} — draining and shutting down`);

      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = undefined;
      }

      // Signal workers to drain (same IPC message + pattern reloadServerConfig() already uses
      // for retiring old workers on hot-reload) rather than hard-killing them immediately —
      // each worker now tracks its own in-flight upstream requests and exits on its own once
      // they finish (see worker.ts's GRACEFUL_SHUTDOWN/maybeExitWhenDrained).
      const workersToRetire = [...WORKER_POOL];
      WORKER_POOL.length = 0;
      for (const worker of workersToRetire) {
        try {
          workerSend(worker, JSON.stringify({ type: "GRACEFUL_SHUTDOWN" }));
        } catch {}
      }

      await cache.disconnect().catch(() => {});

      // Wait at least as long as a legitimate in-flight request is allowed to take, so this
      // doesn't cut off a slow-but-healthy response that was about to finish on its own.
      const drainTimeoutMs = Math.max(10000, (ACTIVE_CONFIG.server.readTimeoutMs ?? 15000) + 2000);
      let settled = false;
      const hardDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn("Master", `Drain timeout (${drainTimeoutMs}ms) exceeded — forcing shutdown`);
        for (const worker of workersToRetire) {
          try {
            if (!worker.isDead()) worker.kill("SIGTERM");
          } catch {}
        }
        process.exit(0);
      }, drainTimeoutMs);
      hardDeadline.unref();

      // server.close() stops accepting *new* connections but waits for in-flight ones to
      // finish naturally before its callback fires — exiting before that callback would cut
      // off a response mid-flight for whoever is still actively being served.
      const closers: Promise<void>[] = [new Promise<void>((resolve) => httpServer.close(() => resolve()))];
      if (httpsServer) {
        closers.push(new Promise<void>((resolve) => httpsServer!.close(() => resolve())));
      }
      await Promise.all(closers);

      if (settled) return; // the hard deadline already fired and is handling shutdown
      settled = true;
      clearTimeout(hardDeadline);
      for (const worker of workersToRetire) {
        try {
          if (!worker.isDead()) worker.kill("SIGTERM");
        } catch {}
      }
      process.exit(0);
    }
    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
    await new Promise((r) => setTimeout(r, 3000));
    await initialHealthCheck(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS, lb);
    const listenBacklog = ACTIVE_CONFIG.server.backlog ?? 511;
    const keepAliveTimeoutMs = ACTIVE_CONFIG.server.keepAliveTimeoutMs ?? 65000;
    const headersTimeoutMs = ACTIVE_CONFIG.server.headersTimeoutMs ?? 66000;
    for (const srv of [httpServer, httpsServer]) {
      if (!srv) continue;
      srv.keepAliveTimeout = keepAliveTimeoutMs;
      srv.headersTimeout = headersTimeoutMs;
    }
    httpServer.listen(port, listenBacklog);
    if (httpsServer) {
      httpsServer.listen(
        ACTIVE_CONFIG.tls?.httpsPort ?? ACTIVE_CONFIG.server.httpsPort ?? 8443,
        listenBacklog,
      );
    }
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    const effectiveDiscovery = getEffectiveDiscovery(ACTIVE_CONFIG);
    healthCheckInterval = startHealthChecks(
      ACTIVE_CONFIG.server.upstreams,
      HEALTHY_UPSTREAMS,
      lb,
      10000,
      {
        consecutiveFailuresToTrip: effectiveDiscovery?.activeProbe?.consecutiveFailuresToTrip,
        consecutiveSuccessesToRecover: effectiveDiscovery?.activeProbe?.consecutiveSuccessesToRecover,
      },
    );
    if (!passiveProbeRegistered) {
      registerPassiveProbeListener(HEALTHY_UPSTREAMS, lb);
      passiveProbeRegistered = true;
    }
    readinessProbe.register({
      name: "upstream-available",
      check: async () => HEALTHY_UPSTREAMS.size > 0,
    });
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
  }
}
