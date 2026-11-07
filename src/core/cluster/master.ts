import cluster, { type Worker } from "node:cluster";
import os from "node:os";

import { initialHealthCheck, startHealthChecks } from "../../discovery/health/health.manager.js";
import { RateLimiter } from "../../ratelimit/rate-limiter.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";
import { logger } from "../../observability/logger/logger.js";
import { tenantLogStreamer } from "../../observability/logger/tenant-log.streamer.js";
import type { RootConfigType } from "../../config/schemas/server.schema.js";

// =============================================================================
//  MASTER — control plane only (Phase B)
// =============================================================================
//  Workers own the entire datapath: they each listen on the shared port
//  (Node's cluster module balances accepted connections across them — no
//  socket or request/response IPC involved) and run the full pipeline —
//  routing, auth, CORS, tracing, rate limiting, cache, load balancing,
//  circuit breaker, retries, and WebSocket tunneling — themselves, talking
//  to upstreams directly.
//
//  Master is left with exactly five jobs:
//    1. Fork and respawn workers.
//    2. Run active health checks and broadcast the result (+ the full
//       registry roster) to every worker.
//    3. Own the canonical ServiceRegistry — workers forward admin mutations
//       (register/heartbeat/deregister) to it over IPC; it broadcasts the
//       new state back out.
//    4. Hot-reload config (SIGHUP / config file watch, via reloadServerConfig).
//    5. Aggregate /metrics across workers, and lease rate-limit tokens to
//       workers in batches when a limiter's storage is in-memory (Redis-
//       storage limiters talk to Redis directly from each worker instead).
// =============================================================================

function getEffectiveRateLimit(config: RootConfigType) {
  return config.rateLimit ?? config.server.rateLimit;
}

function getEffectiveDiscovery(config: RootConfigType) {
  return config.discovery ?? config.server.discovery;
}

interface CreateServerConfig {
  port: number;
  workerCount: number;
  config: RootConfigType;
}

let WORKER_POOL: Worker[] = [];
let ACTIVE_CONFIG: RootConfigType;
let healthCheckInterval: NodeJS.Timeout | undefined;
const HEALTHY_UPSTREAMS: Set<string> = new Set();
let isShuttingDown = false;
let clusterExitHandlerInstalled = false;

// Crash-loop guard: the exit handler below respawns unconditionally, which is correct for a
// rare, legitimate crash hours into uptime but would otherwise spin forever on a startup-time
// failure that hits every worker identically (e.g. tls.enabled with a missing/invalid
// certificate -- worker.ts throws synchronously during bootstrap, before ever binding a
// listener). A worker that dies within WORKER_CRASH_LOOP_WINDOW_MS of being forked counts as a
// "quick death"; enough of those in a row means every respawn is failing the same way, and the
// right behavior is to fail fast and loudly -- a tight fork loop otherwise burns CPU forever
// with no listener ever bound and no clear signal to the operator about what's wrong.
const WORKER_FORK_TIMES = new Map<number, number>();
let consecutiveQuickDeaths = 0;
const WORKER_CRASH_LOOP_WINDOW_MS = 3000;
const WORKER_CRASH_LOOP_THRESHOLD = 6;

// In-memory-storage rate limiters only, keyed by scope ("global" or "route:<path>") — the
// canonical instance a RL_LEASE_REQUEST draws batches of permits from. Redis/hybrid-storage
// limiters are never built here; each worker owns its own instance of those directly.
const memoryRateLimiters = new Map<string, RateLimiter>();

// worker.send() returns false when the IPC pipe's internal write buffer is over its high
// water mark — same signal as a Writable stream's write() returning false. It does NOT mean
// the message failed or was dropped; Node has already queued it internally and will deliver
// it, so this never retries (a retry here would put a second copy of the message on the wire).
function workerSend(worker: Worker, msg: string): void {
  if (worker.isDead() || !worker.isConnected()) return;
  try {
    worker.send(msg);
  } catch {}
}

function broadcastRegistry() {
  const payload = JSON.stringify({
    type: "UPDATE_SERVICES",
    healthyUpstreams: Array.from(HEALTHY_UPSTREAMS),
    registry: registry.getAll(),
  });
  for (const w of WORKER_POOL) {
    if (w.isConnected()) {
      try {
        w.send(payload);
      } catch {}
    }
  }
}

interface MetricQueryRequest {
  resolve: (snapshots: any[]) => void;
  pendingWorkers: Set<number>;
  results: any[];
  timer: NodeJS.Timeout;
}
const pendingMetricQueries = new Map<string, MetricQueryRequest>();

interface CdcInvalidateQuery {
  resolve: (count: number) => void;
  pendingWorkers: Set<number>;
  total: number;
  timer: NodeJS.Timeout;
}
const pendingCdcInvalidateQueries = new Map<string, CdcInvalidateQuery>();

// A worker that handles POST /__cdc/webhook has already invalidated its own L1 cache and the
// shared L2/Redis entry (via cache.handleDebeziumEvent locally) before asking for this — every
// OTHER worker's own L1 copy, invisible from the originating worker, still needs purging too.
// Each other worker re-runs the same Debezium event through its own cache.handleDebeziumEvent
// (redundant L2 work — the keys are already gone, so its own L2 pass finds nothing — but it's
// the simplest way to get that worker's own correct L1-pattern match without a second method).
function broadcastCdcInvalidate(eventJson: string, excludeWorkerId: number): Promise<number> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeWorkers = WORKER_POOL.filter(
      (w) => w.isConnected() && w.id !== excludeWorkerId,
    );
    if (activeWorkers.length === 0) {
      return resolve(0);
    }
    const pendingWorkers = new Set(activeWorkers.map((w) => w.id));
    const cleanup = () => {
      const query = pendingCdcInvalidateQueries.get(requestId);
      if (query) {
        clearTimeout(query.timer);
        pendingCdcInvalidateQueries.delete(requestId);
      }
    };
    const timer = setTimeout(() => {
      const query = pendingCdcInvalidateQueries.get(requestId);
      const total = query?.total ?? 0;
      cleanup();
      resolve(total);
    }, 2000);
    pendingCdcInvalidateQueries.set(requestId, {
      resolve: (total) => {
        cleanup();
        resolve(total);
      },
      pendingWorkers,
      total: 0,
      timer,
    });
    const payload = JSON.stringify({ type: "CDC_INVALIDATE_L1_REQUEST", requestId, eventJson });
    for (const w of activeWorkers) {
      try {
        w.send(payload);
      } catch {
        pendingWorkers.delete(w.id);
      }
    }
    if (pendingWorkers.size === 0) {
      cleanup();
      resolve(0);
    }
  });
}

// Fans DUMP_METRICS_REQUEST out to every connected worker (optionally excluding one, so a
// worker that itself is aggregating for a client's GET /metrics doesn't get asked to report
// on itself a second time — it already has its own snapshot locally) and resolves once every
// worker has replied or 500ms has passed, whichever comes first.
function collectWorkerMetricSnapshots(excludeWorkerId?: number): Promise<any[]> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeWorkers = WORKER_POOL.filter(
      (w) => w.isConnected() && w.id !== excludeWorkerId,
    );
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

// batchSize mirrors how many permits a worker is handed per lease — big enough that a worker
// isn't asking master every other request, small enough that the global cap isn't blown past
// by much when several workers lease around the same time.
function leaseBatchSize(maxRequests: number): number {
  return Math.max(5, Math.ceil(maxRequests * 0.1));
}

async function handleRlLeaseRequest(worker: Worker, parsed: any) {
  const { requestId, scope, key, maxRequests } = parsed;
  const limiter = memoryRateLimiters.get(scope);
  if (!limiter) {
    workerSend(
      worker,
      JSON.stringify({ type: "RL_LEASE_RESPONSE", requestId, granted: 0, resetAt: Date.now(), algorithm: parsed.algorithm }),
    );
    return;
  }
  const batchSize = leaseBatchSize(maxRequests);
  let granted = 0;
  for (let i = 0; i < batchSize; i++) {
    const allowed = await limiter.isAllowed(key);
    if (!allowed) break;
    granted++;
  }
  const resetAt = limiter.getResetTime(key);
  const algoState = await limiter.getAlgorithmState(key);
  workerSend(
    worker,
    JSON.stringify({
      type: "RL_LEASE_RESPONSE",
      requestId,
      granted,
      resetAt,
      algorithm: limiter.getAlgorithm(),
      algoState,
    }),
  );
}

function handleRegistryMutate(worker: Worker, parsed: any) {
  const { requestId, action, payload } = parsed;
  let result: any;
  let error: string | undefined;
  try {
    if (action === "register") {
      result = registry.register(payload);
    } else if (action === "deregister") {
      result = registry.deregister(payload.id);
    } else if (action === "heartbeat") {
      result = registry.heartbeat(payload.id);
    } else {
      error = `Unknown registry action: ${action}`;
    }
  } catch (err: any) {
    error = err.message;
  }
  workerSend(worker, JSON.stringify({ type: "REGISTRY_MUTATE_RESPONSE", requestId, result, error }));
}

function setupWorkerMessageHandling(worker: Worker) {
  worker.on("message", (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
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
      if (parsed.type === "METRICS_AGGREGATE_REQUEST") {
        void collectWorkerMetricSnapshots(worker.id).then((snapshots) => {
          workerSend(
            worker,
            JSON.stringify({ type: "METRICS_AGGREGATE_RESPONSE", requestId: parsed.requestId, snapshots }),
          );
        });
        return;
      }
      if (parsed.type === "REGISTRY_MUTATE") {
        handleRegistryMutate(worker, parsed);
        return;
      }
      if (parsed.type === "RL_LEASE_REQUEST") {
        void handleRlLeaseRequest(worker, parsed);
        return;
      }
      if (parsed.type === "CDC_INVALIDATE_BROADCAST_REQUEST") {
        void broadcastCdcInvalidate(parsed.eventJson, worker.id).then((count) => {
          workerSend(
            worker,
            JSON.stringify({ type: "CDC_INVALIDATE_BROADCAST_RESPONSE", requestId: parsed.requestId, count }),
          );
        });
        return;
      }
      if (parsed.type === "CDC_INVALIDATE_L1_RESPONSE") {
        const query = pendingCdcInvalidateQueries.get(parsed.requestId);
        if (query) {
          query.total += parsed.count ?? 0;
          query.pendingWorkers.delete(worker.id);
          if (query.pendingWorkers.size === 0) {
            query.resolve(query.total);
          }
        }
        return;
      }
    } catch (err: any) {
      logger.error("Master", `Error processing worker message: ${err.message}`);
    }
  });
}

function rebuildMemoryRateLimiters(config: RootConfigType) {
  memoryRateLimiters.clear();
  const effectiveRateLimit = getEffectiveRateLimit(config);
  if (effectiveRateLimit && effectiveRateLimit.enabled !== false && effectiveRateLimit.storage !== "redis" && effectiveRateLimit.storage !== "hybrid") {
    memoryRateLimiters.set(
      "global",
      new RateLimiter({
        windowMs: effectiveRateLimit.windowMs,
        maxRequests: effectiveRateLimit.maxRequests,
        algorithm: effectiveRateLimit.algorithm,
        storage: "memory",
        softLimit: effectiveRateLimit.softLimit,
        burstMultiplier: effectiveRateLimit.burstMultiplier,
      }),
    );
  }
  config.server.paths.forEach((p: any) => {
    if (p.rateLimit && p.rateLimit.storage !== "redis" && p.rateLimit.storage !== "hybrid") {
      memoryRateLimiters.set(
        `route:${p.path}`,
        new RateLimiter({
          windowMs: p.rateLimit.windowMs,
          maxRequests: p.rateLimit.maxRequests,
          algorithm: p.rateLimit.algorithm,
          storage: "memory",
        }),
      );
    }
  });
}

function syncRegistryFromConfig(config: RootConfigType) {
  config.server.upstreams.forEach((u) => {
    HEALTHY_UPSTREAMS.add(u.id);
    registry.register({ id: u.id, url: u.url });
  });
  const configuredIds = new Set(config.server.upstreams.map((u) => u.id));
  for (const service of registry.getAll()) {
    if (!configuredIds.has(service.id) && service.metadata?.["dynamic"] !== "true") {
      registry.deregister(service.id);
    }
  }
}

export async function reloadServerConfig(newConfig: RootConfigType) {
  logger.info("Master", "Hot-reload initiated — rebuilding dependencies and workers");
  ACTIVE_CONFIG = newConfig;

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = undefined;
  }
  HEALTHY_UPSTREAMS.clear();
  syncRegistryFromConfig(newConfig);
  rebuildMemoryRateLimiters(newConfig);

  if (newConfig.observability?.tenantDelivery?.mode === "webhook") {
    tenantLogStreamer.configure(newConfig.observability.tenantDelivery.exportEndpoints);
  } else {
    tenantLogStreamer.stop();
  }

  const oldWorkers = [...WORKER_POOL];
  WORKER_POOL.length = 0;
  const targetWorkers =
    newConfig.server.workers && newConfig.server.workers > 0 ? newConfig.server.workers : os.cpus().length;
  for (let i = 0; i < targetWorkers; i++) {
    const worker = cluster.fork({ APP_CONFIG: JSON.stringify(newConfig) });
    setupWorkerMessageHandling(worker);
    WORKER_POOL.push(worker);
  }
  broadcastRegistry();

  const effectiveDiscovery = getEffectiveDiscovery(newConfig);
  await initialHealthCheck(newConfig.server.upstreams, HEALTHY_UPSTREAMS, undefined, broadcastRegistry);
  healthCheckInterval = startHealthChecks(newConfig.server.upstreams, HEALTHY_UPSTREAMS, undefined, 10000, {
    consecutiveFailuresToTrip: effectiveDiscovery?.activeProbe?.consecutiveFailuresToTrip,
    consecutiveSuccessesToRecover: effectiveDiscovery?.activeProbe?.consecutiveSuccessesToRecover,
    onChange: broadcastRegistry,
  });

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
  const { workerCount } = config;
  if (ACTIVE_CONFIG.admin.enabled && !ACTIVE_CONFIG.admin.token) {
    logger.warn(
      "Admin",
      "Admin endpoints are enabled but no admin.token/ADMIN_SECRET is configured — all /__* requests will be rejected until a token is set",
    );
  }
  if (!cluster.isPrimary) return;

  registry.onRegister((service) => {
    HEALTHY_UPSTREAMS.add(service.id);
    broadcastRegistry();
  });
  registry.onDeregister((service) => {
    HEALTHY_UPSTREAMS.delete(service.id);
    broadcastRegistry();
  });
  syncRegistryFromConfig(ACTIVE_CONFIG);
  rebuildMemoryRateLimiters(ACTIVE_CONFIG);

  if (ACTIVE_CONFIG.observability?.tenantDelivery?.mode === "webhook") {
    tenantLogStreamer.configure(ACTIVE_CONFIG.observability.tenantDelivery.exportEndpoints);
  }

  if (!clusterExitHandlerInstalled) {
    clusterExitHandlerInstalled = true;
    cluster.on("exit", (worker) => {
      if (isShuttingDown) return;
      const idx = WORKER_POOL.indexOf(worker);
      if (idx !== -1) {
        WORKER_POOL.splice(idx, 1);
        const forkedAt = WORKER_FORK_TIMES.get(worker.id) ?? 0;
        WORKER_FORK_TIMES.delete(worker.id);
        const lifetimeMs = Date.now() - forkedAt;
        if (lifetimeMs < WORKER_CRASH_LOOP_WINDOW_MS) {
          consecutiveQuickDeaths++;
        } else {
          consecutiveQuickDeaths = 0;
        }
        if (consecutiveQuickDeaths >= WORKER_CRASH_LOOP_THRESHOLD) {
          logger.error(
            "Master",
            `Worker crash loop detected: ${consecutiveQuickDeaths} consecutive workers exited within ${WORKER_CRASH_LOOP_WINDOW_MS}ms of starting (worker ${worker.id} lived ${lifetimeMs}ms). Refusing to respawn further -- check the startup error above (a bad TLS certificate is the most common cause). Exiting.`,
          );
          process.exit(1);
        }
        const newWorker = cluster.fork({ APP_CONFIG: JSON.stringify(ACTIVE_CONFIG) });
        WORKER_FORK_TIMES.set(newWorker.id, Date.now());
        setupWorkerMessageHandling(newWorker);
        WORKER_POOL.push(newWorker);
        logger.info("Master", `Worker ${worker.id} exited unexpectedly — respawned as worker ${newWorker.id}`);
        broadcastRegistry();
      }
    });
  }

  const effectiveWorkerCount = workerCount && workerCount > 0 ? workerCount : os.cpus().length;
  for (let i = 0; i < effectiveWorkerCount; i++) {
    const worker = cluster.fork({ APP_CONFIG: JSON.stringify(ACTIVE_CONFIG) });
    WORKER_FORK_TIMES.set(worker.id, Date.now());
    setupWorkerMessageHandling(worker);
    WORKER_POOL.push(worker);
  }
  broadcastRegistry();

  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("Master", `Received ${signal} — draining and shutting down`);

    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = undefined;
    }

    const workersToRetire = [...WORKER_POOL];
    WORKER_POOL.length = 0;
    for (const worker of workersToRetire) {
      try {
        workerSend(worker, JSON.stringify({ type: "GRACEFUL_SHUTDOWN" }));
      } catch {}
    }

    // Each worker drains its own in-flight requests (see worker.ts's GRACEFUL_SHUTDOWN
    // handling) and exits on its own; wait for all of them, but no longer than a legitimate
    // in-flight request is allowed to take, so a slow-but-healthy response isn't cut short.
    const drainTimeoutMs = Math.max(10000, (ACTIVE_CONFIG.server.readTimeoutMs ?? 15000) + 2000);
    await new Promise<void>((resolve) => {
      if (workersToRetire.length === 0) {
        resolve();
        return;
      }
      let settled = false;
      let remaining = workersToRetire.length;
      const hardDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn("Master", `Drain timeout (${drainTimeoutMs}ms) exceeded — forcing shutdown`);
        for (const worker of workersToRetire) {
          try {
            if (!worker.isDead()) worker.kill("SIGTERM");
          } catch {}
        }
        resolve();
      }, drainTimeoutMs);
      for (const worker of workersToRetire) {
        worker.once("exit", () => {
          remaining--;
          if (remaining <= 0 && !settled) {
            settled = true;
            clearTimeout(hardDeadline);
            resolve();
          }
        });
      }
    });
    process.exit(0);
  }
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

  await new Promise((r) => setTimeout(r, 3000));
  const effectiveDiscovery = getEffectiveDiscovery(ACTIVE_CONFIG);
  await initialHealthCheck(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS, undefined, broadcastRegistry);
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = startHealthChecks(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS, undefined, 10000, {
    consecutiveFailuresToTrip: effectiveDiscovery?.activeProbe?.consecutiveFailuresToTrip,
    consecutiveSuccessesToRecover: effectiveDiscovery?.activeProbe?.consecutiveSuccessesToRecover,
    onChange: broadcastRegistry,
  });
}
