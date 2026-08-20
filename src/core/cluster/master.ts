import http from "http";
import https from "https";
import { readFileSync } from "fs";
import fs from "node:fs";
import net from "net";
import cluster, { type Worker } from "node:cluster";

import {
  workerMessageReplySchema,
  type WorkerMessageType,
} from "./ipc.protocol.js";

import { initialHealthCheck, startHealthChecks, registerPassiveProbeListener } from "../../discovery/health/health.manager.js";
import { RateLimiter } from "../../ratelimit/rate-limiter.js";
import { LoadBalancer, createLoadBalancer } from "../../balancer/index.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";
import { Cache } from "../../cache/cache-manager.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { writeAccessLog, logger } from "../../observability/logger/logger.js";
import { globalRetryBudget } from "../../resilience/retry/retry-budget.js";
import { Bulkhead } from "../../resilience/bulkhead/bulkhead.js";
import { calculateExponentialBackoff } from "../../resilience/retry/backoff/exponential.backoff.js";
import { calculateFullJitterBackoff } from "../../resilience/retry/backoff/full-jitter.backoff.js";
import { calculateEqualJitterBackoff } from "../../resilience/retry/backoff/equal-jitter.backoff.js";
import { calculateDecorrelatedJitterBackoff } from "../../resilience/retry/backoff/decorrelated-jitter.backoff.js";
import { passiveProbe } from "../../discovery/health/passive.probe.js";
import { readinessProbe } from "../../observability/health/readiness.js";

import type { RootConfigType } from "../../config/schemas/server.schema.js";

interface CreateServerConfig {
  port: number;
  workerCount: number;
  config: RootConfigType;
}

let WORKER_POOL: Worker[] = [];
let ACTIVE_CONFIG: RootConfigType;
let lb: LoadBalancer;
let cache: Cache;
let metricsRegistry: MetricsRegistry;
const HEALTHY_UPSTREAMS: Set<string> = new Set();
const rateLimiters = new Map<string, RateLimiter>();
const upstreamBulkheads = new Map<string, Bulkhead>();
let nextWorkerIndex = 0;

interface PendingRequest {
  resolve: (parsed: any) => void;
  timer: NodeJS.Timeout;
  upstreamId: string;
  startTime: number;
  payload: WorkerMessageType;
  clientIp: string;
  res: http.ServerResponse;
}
const pendingRequests = new Map<string, PendingRequest>();

function setupWorkerMessageHandling(worker: Worker) {
  worker.on("message", async (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
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

export async function reloadServerConfig(newConfig: RootConfigType) {
  logger.info("Master", "Hot-reload initiated — rebuilding dependencies and workers");
  ACTIVE_CONFIG = newConfig; 

  lb = createLoadBalancer({
    strategy: newConfig.server.loadBalancing.strategy,
    upstreams: newConfig.server.upstreams,
    virtualNodes: newConfig.server.loadBalancing.virtualNodes,
    ewmaAlpha: newConfig.server.loadBalancing.ewmaAlpha,
    stickyCookieName: newConfig.server.loadBalancing.stickyCookieName,
    slowStartSeconds: newConfig.server.loadBalancing.slowStartSeconds,
    circuitBreaker: newConfig.server.resilience?.circuitBreaker,
  });

  HEALTHY_UPSTREAMS.clear();
  newConfig.server.upstreams.forEach((u) => {
    HEALTHY_UPSTREAMS.add(u.id);
    registry.register({ id: u.id, url: u.url });
  });

  if (cache) {
    await cache.disconnect().catch(() => {});
  }
  cache = new Cache({
    enabled: newConfig.server.cache.enabled,
    host: newConfig.server.cache.host,
    port: newConfig.server.cache.port,
    ttlSeconds: newConfig.server.cache.ttlSeconds,
    l1Enabled: newConfig.server.cache.l1Enabled,
    l1MaxSize: newConfig.server.cache.l1MaxSize,
    staleWhileRevalidate: newConfig.server.cache.staleWhileRevalidate,
    staleIfError: newConfig.server.cache.staleIfError,
    debezium: newConfig.server.cache.debezium,
  });
  await cache.connect().catch(() => {});

  rateLimiters.clear();
  upstreamBulkheads.clear();
  newConfig.server.paths.forEach((p) => {
    const rlConfig = p.rateLimit ?? newConfig.server.rateLimit;
    if (rlConfig) {
      rateLimiters.set(
        p.path,
        new RateLimiter({
          windowMs: rlConfig.windowMs,
          maxRequests: rlConfig.maxRequests,
          algorithm: rlConfig.algorithm,
          storage: rlConfig.storage,
          redisClient: cache ? cache.getClient() : undefined,
        }),
      );
    }
  });

  const oldWorkers = [...WORKER_POOL];
  WORKER_POOL.length = 0;
  const targetWorkers = newConfig.server.workers ?? 2;

  for (let i = 0; i < targetWorkers; i++) {
    const worker = cluster.fork({
      APP_CONFIG: JSON.stringify(newConfig),
    });
    setupWorkerMessageHandling(worker);
    WORKER_POOL.push(worker);
  }

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
  const { port, workerCount } = config;

  ACTIVE_CONFIG.server.upstreams.forEach((e) => HEALTHY_UPSTREAMS.add(e.id));

  if (cluster.isPrimary) {
    cache = new Cache({
      enabled: ACTIVE_CONFIG.server.cache.enabled,
      host: ACTIVE_CONFIG.server.cache.host,
      port: ACTIVE_CONFIG.server.cache.port,
      ttlSeconds: ACTIVE_CONFIG.server.cache.ttlSeconds,
      l1Enabled: ACTIVE_CONFIG.server.cache.l1Enabled,
      l1MaxSize: ACTIVE_CONFIG.server.cache.l1MaxSize,
      staleWhileRevalidate: ACTIVE_CONFIG.server.cache.staleWhileRevalidate,
      staleIfError: ACTIVE_CONFIG.server.cache.staleIfError,
      debezium: ACTIVE_CONFIG.server.cache.debezium,
    });
    await cache.connect();

    ACTIVE_CONFIG.server.paths.forEach((p) => {
      const rlConfig = p.rateLimit ?? ACTIVE_CONFIG.server.rateLimit;
      if (rlConfig) {
        rateLimiters.set(
          p.path,
          new RateLimiter({
            windowMs: rlConfig.windowMs,
            maxRequests: rlConfig.maxRequests,
            algorithm: rlConfig.algorithm,
            storage: rlConfig.storage,
            redisClient: cache ? cache.getClient() : undefined,
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
    registry.onRegister((service) => {
      HEALTHY_UPSTREAMS.add(service.id);
      lb.addUpstream(service.id, service.url);
      lb.setHealthy(service.id, true);
    });

    registry.onDeregister((service) => {
      HEALTHY_UPSTREAMS.delete(service.id);
      lb.removeUpstream(service.id);
    });

    ACTIVE_CONFIG.server.upstreams.forEach((u) => {
      registry.register({ id: u.id, url: u.url });
    });

    let sslOptions: { key: Buffer; cert: Buffer };
    try {
      const keyPath = ACTIVE_CONFIG.server.sslKeyPath || (fs.existsSync("/etc/ninja-proxy/certs/key.pem") ? "/etc/ninja-proxy/certs/key.pem" : "./key.pem");
      const certPath = ACTIVE_CONFIG.server.sslCertPath || (fs.existsSync("/etc/ninja-proxy/certs/cert.pem") ? "/etc/ninja-proxy/certs/cert.pem" : "./cert.pem");
      sslOptions = {
        key: readFileSync(keyPath),
        cert: readFileSync(certPath),
      };
    } catch (err: any) {
      logger.error("Master", `Failed to load TLS certificates: ${err.message}`);
      throw err;
    }

    cluster.on("exit", (worker) => {
      const idx = WORKER_POOL.indexOf(worker);
      if (idx !== -1) {
        WORKER_POOL.splice(idx, 1);
        const newWorker = cluster.fork({
          APP_CONFIG: JSON.stringify(ACTIVE_CONFIG),
        });
        setupWorkerMessageHandling(newWorker);
        WORKER_POOL.push(newWorker);
      }
    });

    for (let i = 0; i < workerCount; i++) {
      const worker = cluster.fork({
        APP_CONFIG: JSON.stringify(ACTIVE_CONFIG),
      });
      setupWorkerMessageHandling(worker);
      WORKER_POOL.push(worker);
    }

    function dispatchToWorker(
      payload: WorkerMessageType,
      clientIp: string,
      res: http.ServerResponse,
      attempt = 0,
      attemptedUpstreams: Set<string> = new Set(),
      startTime = performance.now(),
    ) {
      globalRetryBudget.recordRequest();

      const pathRule = ACTIVE_CONFIG.server.paths.find((p) =>
        payload.url.startsWith(p.path),
      );

      const allowedUpstreams = pathRule?.upstream ?? [];
      const routeHealthyUpstreams = new Set(
        [...HEALTHY_UPSTREAMS].filter((id) => allowedUpstreams.includes(id))
      );

      let upstreamId: string | null = null;
      if (pathRule?.sticky) {
        const cookies = parseCookies(payload.headers.cookie);
        const stickId = cookies[ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"];
        if (
          stickId &&
          routeHealthyUpstreams.has(stickId) &&
          !attemptedUpstreams.has(stickId)
        ) {
          upstreamId = stickId;
        }
      }

      if (!upstreamId) {
        upstreamId = lb.pickFiltered(
          routeHealthyUpstreams.size > 0 ? routeHealthyUpstreams : HEALTHY_UPSTREAMS,
          clientIp,
          attemptedUpstreams,
          payload.headers.cookie,
        );
      }

      if (!upstreamId) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No healthy upstreams available" }));
        metricsRegistry.recordRequest(
          payload.requestType,
          payload.url,
          503,
          "none",
          performance.now() - startTime,
        );
        return;
      }

      attemptedUpstreams.add(upstreamId);
      let bulkhead = upstreamBulkheads.get(upstreamId);
      if (!bulkhead) {
        const upstreamConf = ACTIVE_CONFIG.server.upstreams.find((u) => u.id === upstreamId);
        const maxConcurrent = upstreamConf?.maxConnections ?? 1000;
        bulkhead = new Bulkhead(maxConcurrent);
        upstreamBulkheads.set(upstreamId, bulkhead);
      }

      if (!bulkhead.enter()) {
        logger.warn("Resilience", `Bulkhead capacity reached for upstream: ${upstreamId}`);
        const retryConfig = ACTIVE_CONFIG.server.loadBalancing.retry;
        const retryAllowed = globalRetryBudget.recordRetry();
        if (retryAllowed && attempt < retryConfig.maxAttempts) {
          dispatchToWorker(payload, clientIp, res, attempt + 1, attemptedUpstreams, startTime);
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Service unavailable — upstream concurrency limit reached" }));
          metricsRegistry.recordRequest(payload.requestType, payload.url, 503, upstreamId, performance.now() - startTime);
        }
        return;
      }

      metricsRegistry.recordActiveConnection(upstreamId, 1);
      lb.incrementConnection(upstreamId);
      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
        upstreamBulkheads.get(upstreamId)?.leave();
        metricsRegistry.recordActiveConnection(upstreamId, -1);
        lb.releaseConnection(upstreamId);
        res.writeHead(503);
        res.end("Service not found in registry");
        return;
      }

      const enrichedPayload = {
        ...payload,
        upstreamId,
        upstreamUrl: serviceInstance.url,
        clientIp, 
      };

      const workerIndex = (attempt === 0) ? (nextWorkerIndex++) % WORKER_POOL.length : (nextWorkerIndex + attempt) % WORKER_POOL.length;
      const worker = WORKER_POOL[workerIndex];
      if (!worker) {
        metricsRegistry.recordActiveConnection(upstreamId, -1);
        lb.releaseConnection(upstreamId);
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
          res.writeHead(504);
          res.end("Gateway Timeout");
          metricsRegistry.recordRequest(
            payload.requestType,
            payload.url,
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

      pendingRequests.set(requestId, {
        timer,
        upstreamId,
        startTime,
        payload,
        clientIp,
        res,
        resolve: async (rawReply: any) => {
          const reply = await workerMessageReplySchema.parseAsync(rawReply);
          const retryConfig = ACTIVE_CONFIG.server.loadBalancing.retry;
          const errorStatus = reply.statusCode ?? 502;
          const isRetryable =
            reply.errorCode ||
            (reply.statusCode && retryConfig.statusCodes.includes(reply.statusCode));

          if (isRetryable) {
            logger.warn("Master", `Upstream failure: errorCode=${reply.errorCode}, status=${reply.statusCode}`, { upstreamId });
            lb.recordFailure(upstreamId!);
            passiveProbe.record({
              upstreamId: upstreamId!,
              statusCode: errorStatus,
              latencyMs: performance.now() - startTime,
            });

            const isLocalFailure = errorStatus === 500 || errorStatus === 502;
            const retryAllowed = globalRetryBudget.recordRetry();

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
                    jitterDelay = calculateDecorrelatedJitterBackoff(attempt, baseDelayMs, maxDelayMs);
                    break;
                  case "full-jitter":
                  default:
                    jitterDelay = calculateFullJitterBackoff(attempt, baseDelayMs, maxDelayMs);
                    break;
                }

                logger.warn("Master", `Backing off (${backoffType}) for ${Math.round(jitterDelay)}ms before retry`);

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
                  );
                }, jitterDelay);
              }
            } else {
              upstreamBulkheads.get(upstreamId!)?.leave();
              metricsRegistry.recordActiveConnection(upstreamId!, -1);
              lb.releaseConnection(upstreamId!);
              res.writeHead(errorStatus);
              res.end(reply.error || "Bad Gateway");
              metricsRegistry.recordRequest(
                payload.requestType,
                payload.url,
                errorStatus,
                upstreamId!,
                performance.now() - startTime,
              );
              writeAccessLog(
                ACTIVE_CONFIG.server.accessLog,
                clientIp,
                payload.requestType,
                payload.url,
                errorStatus,
                0,
                performance.now() - startTime,
                (payload.headers["user-agent"] as string) ?? "-",
              );
            }
          } else {
            let responseData: Buffer | string = reply.data;
            if (reply.isCompressed && reply.encoding === "gzip") {
              responseData = Buffer.from(reply.data, "base64");
            }
            const latencyMs = performance.now() - startTime;
            const responseBytes =
              typeof responseData === "string" ? Buffer.byteLength(responseData) : responseData.length;

            lb.recordSuccess(upstreamId!, latencyMs);
            passiveProbe.record({
              upstreamId: upstreamId!,
              statusCode: reply.statusCode ?? 200,
              latencyMs,
            });
            upstreamBulkheads.get(upstreamId!)?.leave();
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            lb.releaseConnection(upstreamId!);

            metricsRegistry.recordRequest(
              payload.requestType,
              payload.url,
              reply.statusCode ?? 200,
              upstreamId!,
              latencyMs,
            );

            if (payload.requestType === "GET") {
              metricsRegistry.recordCacheOp("miss");
            }

            const cacheControl = reply.headers?.["cache-control"] || "";
            const hasSetCookie = !!reply.headers?.["set-cookie"];
            const isPrivate = cacheControl.includes("private") || cacheControl.includes("no-store") || cacheControl.includes("no-cache");
            const isCacheable = (reply.statusCode === 200 || reply.statusCode === 301) &&
              !payload.headers["authorization"] &&
              !hasSetCookie &&
              !isPrivate;

            if (isCacheable && payload.requestType === "GET") {
              const parsedUrl = new URL(payload.url, "http://dummy");
              const cacheKey = cache.buildKey(
                payload.requestType,
                parsedUrl.pathname + parsedUrl.search,
              );
              const cachePayload = JSON.stringify({
                statusCode: reply.statusCode ?? 200,
                headers: reply.headers ?? {},
                body: reply.data,
                isCompressed: reply.isCompressed ?? false,
                encoding: reply.encoding,
              });
              const ttlOverride = pathRule?.cache?.ttlSeconds;
              await cache.set(cacheKey, cachePayload, ttlOverride);
            }

            const responseHeaders: Record<string, any> = {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Credentials": "true",
              ...(reply.headers || {}),
            };

            delete responseHeaders["content-length"];
            delete responseHeaders["transfer-encoding"];
            delete responseHeaders["connection"];

            if (pathRule?.sticky) {
              const maxAge = ACTIVE_CONFIG.server.loadBalancing.stickyCookieTtlMs
                ? `; Max-Age=${Math.round(ACTIVE_CONFIG.server.loadBalancing.stickyCookieTtlMs / 1000)}`
                : "";
              responseHeaders["Set-Cookie"] =
                `${ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"}=${upstreamId}; Path=/; HttpOnly; SameSite=Lax${maxAge}`;
            }

            res.writeHead(reply.statusCode ?? 200, responseHeaders);
            res.end(responseData);

            writeAccessLog(
              ACTIVE_CONFIG.server.accessLog,
              clientIp,
              payload.requestType,
              payload.url,
              reply.statusCode ?? 200,
              responseBytes,
              latencyMs,
              (payload.headers["user-agent"] as string) ?? "-",
            );
          }
        }
      });

      worker.send(
        JSON.stringify({
          ...enrichedPayload,
          requestId,
        }),
      );
    }

    const httpServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/__registry")) {
        httpsServer.emit("request", req, res);
        return;
      }
      const httpsUrl = `https://${req.headers.host?.replace(
        String(port),
        String(ACTIVE_CONFIG.server.httpsPort ?? 8443),
      )}${req.url}`;
      res.writeHead(301, { Location: httpsUrl });
      res.end();
    });

    const wsUpgradeHandler = (
      req: http.IncomingMessage,
      socket: net.Socket,
      head: Buffer,
    ) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const pathRule = ACTIVE_CONFIG.server.paths.find((p) =>
        url.pathname.startsWith(p.path),
      );

      if (!pathRule) {
        socket.destroy();
        return;
      }

      const clientIP =
        (req.headers["x-forwarded-for"] as string) ??
        socket.remoteAddress ??
        "unknown";
      const allowedUpstreams = pathRule?.upstream ?? [];
      const routeHealthyUpstreams = new Set(
        [...HEALTHY_UPSTREAMS].filter((id) => allowedUpstreams.includes(id))
      );

      const upstreamId = lb.pickFiltered(
        routeHealthyUpstreams.size > 0 ? routeHealthyUpstreams : HEALTHY_UPSTREAMS,
        clientIP,
        new Set(),
        req.headers.cookie,
      );
      if (!upstreamId) {
        socket.destroy();
        return;
      }

      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
        socket.destroy();
        return;
      }

      if (WORKER_POOL.length === 0) {
        socket.destroy();
        return;
      }

      const workerIndex = Math.floor(Math.random() * WORKER_POOL.length);
      const worker = WORKER_POOL[workerIndex];
      if (!worker) {
        socket.destroy();
        return;
      }

      const reqFields = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        httpVersion: req.httpVersion,
        headers: req.headers,
      };

      const payload = {
        type: "WEBSOCKET_UPGRADE",
        reqFields,
        upstreamId,
        upstreamUrl: serviceInstance.url,
        head: head.toString("base64"),
      };

      worker.send(JSON.stringify(payload), socket);
      socket.pause();
      socket.removeAllListeners();
    };

    httpServer.on("upgrade", wsUpgradeHandler);

    const httpsServer = https.createServer(sslOptions, async (req, res) => {
      const clientIP =
        (req.headers["x-forwarded-for"] as string) ??
        req.socket.remoteAddress ??
        "unknown";

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Credentials": "true",
        });
        res.end();
        return;
      }

      if (req.url === "/__lb-stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              strategy: ACTIVE_CONFIG.server.loadBalancing.strategy,
              upstreams: lb.getStats(),
              healthyUpstreams: [...HEALTHY_UPSTREAMS],
            },
            null,
            2,
          ),
        );
        return;
      }

      if (req.url === "/metrics" || req.url === "/__metrics") {
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        });
        const allUpstreams = [
          ...new Set([
            ...ACTIVE_CONFIG.server.upstreams.map((u) => u.id),
            ...registry.getAll().map((s) => s.id),
          ]),
        ];
        res.end(metricsRegistry.getExpositionFormat(allUpstreams));
        return;
      }

      if (req.url === "/__registry") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(registry.getStats(), null, 2));
        return;
      }

      if (req.url === "/__ready") {
        const result = await readinessProbe.isReady();
        res.writeHead(result.ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === "/__cache-stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cache.getStats(), null, 2));
        return;
      }

      // Dynamic Registration Endpoints (Issue 4)
      if (req.url === "/__registry/register" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const { id, url, metadata } = JSON.parse(body);
            if (!id || !url) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "id and url are required" }));
              return;
            }
            const service = registry.register({ id, url, metadata });
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                message: `Service ${id} registered!`,
                service,
              }),
            );
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
          }
        });
        return;
      }

      if (req.url?.startsWith("/__registry/heartbeat/") && req.method === "PUT") {
        const id = req.url.substring("/__registry/heartbeat/".length);
        if (id) {
          const success = registry.heartbeat(id);
          if (success) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "OK", message: `Heartbeat for ${id} recorded` }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Service ${id} not found` }));
          }
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Service id is required" }));
        }
        return;
      }

      if (req.url?.startsWith("/__registry/deregister/") && req.method === "DELETE") {
        const id = req.url.substring("/__registry/deregister/".length);
        if (id) {
          const success = registry.deregister(id);
          if (success) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: `Service ${id} deregistered` }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Service ${id} not found` }));
          }
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Service id is required" }));
        }
        return;
      }

      const url = new URL(req.url!, `https://${req.headers.host}`);
      const pathRule = ACTIVE_CONFIG.server.paths.find((p) =>
        url.pathname.startsWith(p.path),
      );

      const activeLimitConfig = pathRule?.rateLimit ?? ACTIVE_CONFIG.server.rateLimit;
      if (activeLimitConfig && pathRule) {
        const routeLimiter = rateLimiters.get(pathRule.path);
        if (routeLimiter && !(await routeLimiter.isAllowed(clientIP))) {
          const retryAfter = Math.ceil(
            (routeLimiter.getResetTime(clientIP) - Date.now()) / 1000,
          );
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": retryAfter.toString(),
            "X-RateLimit-Limit": activeLimitConfig.maxRequests.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": routeLimiter.getResetTime(clientIP).toString(),
            "X-RateLimit-Algorithm": routeLimiter.getAlgorithm(),
          });
          res.end(
            JSON.stringify({
              error: "Too Many Requests",
              retryAfter: `${retryAfter}s`,
              algorithm: routeLimiter.getAlgorithm(),
            }),
          );
          return;
        }
      }


      if (req.method === "GET") {
        const skipCache = url.pathname.startsWith("/api/upload/") || (pathRule?.cache?.enabled === false);
        if (!skipCache) {
          const cacheKey = cache.buildKey("GET", url.pathname + url.search);
          const cachedJson = await cache.get(cacheKey);
          if (cachedJson) {
            try {
              const cached = JSON.parse(cachedJson);
              res.writeHead(cached.statusCode ?? 200, {
                ...(cached.headers || {}),
                "X-Cache": "HIT",
              });
              const bodyBuf = cached.isCompressed && cached.encoding === "gzip"
                ? Buffer.from(cached.body, "base64")
                : cached.body;
              res.end(bodyBuf);
              metricsRegistry.recordCacheOp("hit");
              metricsRegistry.recordRequest(
                "GET",
                req.url ?? "",
                cached.statusCode ?? 200,
                "cache",
                0,
              );
              writeAccessLog(
                ACTIVE_CONFIG.server.accessLog,
                clientIP,
                req.method,
                req.url ?? "",
                cached.statusCode ?? 200,
                Buffer.byteLength(bodyBuf),
                0,
                (req.headers["user-agent"] as string) ?? "-",
              );
              return;
            } catch {
              // fallback if cache corrup
            }
          }
        }
      }

      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) {
        await cache.invalidate(url.pathname);
      }
      const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
      if (contentLength > 10 * 1024 * 1024) { 
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const bodyBuffer = Buffer.concat(chunks);
        const body =
          bodyBuffer.length > 0 ? bodyBuffer.toString("binary") : null;
        const payload: WorkerMessageType = {
          requestType: req.method ?? "GET",
          headers: req.headers,
          body: body,
          url: `${req.url}`,
        };
        dispatchToWorker(payload, clientIP, res);
      });
    });

    httpsServer.on("upgrade", wsUpgradeHandler);

    let isShuttingDown = false;
    async function gracefulShutdown(signal: string) {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info("Master", `Received ${signal} — draining and shutting down`);
      await cache.disconnect();
      httpServer.close();
      httpsServer.close(() => {
        process.exit(0);
      });
    }

    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

    await new Promise((r) => setTimeout(r, 3000));
    await initialHealthCheck(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS, lb);

    httpServer.listen(port);
    httpsServer.listen(ACTIVE_CONFIG.server.httpsPort ?? 8443, () => {
      startHealthChecks(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS, lb);
      registerPassiveProbeListener(HEALTHY_UPSTREAMS, lb);

      // Register readiness checks — exposed at /__ready
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
    });
  }
}
