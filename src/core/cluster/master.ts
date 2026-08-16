import http from "http";
import https from "https";
import { readFileSync } from "fs";
import net from "net";
import cluster, { type Worker } from "node:cluster";

import {
  workerMessageReplySchema,
  type WorkerMessageType,
} from "./ipc.protocol.js";

import { initialHealthCheck, startHealthChecks } from "../../discovery/health/health.manager.js";
import { RateLimiter } from "../../ratelimit/rate-limiter.js";
import { LoadBalancer } from "../../balancer/core/load-balancer.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";
import { Cache } from "../../cache/cache-manager.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { writeAccessLog, logger } from "../../observability/logger/logger.js";
import { globalRetryBudget } from "../../resilience/retry/retry-budget.js";

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
  logger.info("Master", "Hot-reload initiated — spawning replacement workers");
  ACTIVE_CONFIG = newConfig;

  lb = new LoadBalancer({
    strategy: newConfig.server.loadBalancing.strategy,
    upstreams: newConfig.server.upstreams,
    failureThreshold: newConfig.server.loadBalancing.failureThreshold,
    recoveryTimeMs: newConfig.server.loadBalancing.recoveryTimeMs,
    virtualNodes: newConfig.server.loadBalancing.virtualNodes,
    ewmaAlpha: newConfig.server.loadBalancing.ewmaAlpha,
    stickyCookieName: newConfig.server.loadBalancing.stickyCookieName,
    slowStartSeconds: newConfig.server.loadBalancing.slowStartSeconds,
  });

  const oldWorkers = [...WORKER_POOL];
  WORKER_POOL.length = 0;
  const targetWorkers = newConfig.server.workers ?? 2;

  for (let i = 0; i < targetWorkers; i++) {
    const worker = cluster.fork({
      APP_CONFIG: JSON.stringify(newConfig),
    });
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
    const sslOptions = {
      key: readFileSync("key.pem"),
      cert: readFileSync("cert.pem"),
    };

    ACTIVE_CONFIG.server.paths.forEach((p) => {
      if (p.rateLimit) {
        rateLimiters.set(
          p.path,
          new RateLimiter({
            windowMs: p.rateLimit.windowMs,
            maxRequests: p.rateLimit.maxRequests,
            algorithm: p.rateLimit.algorithm,
            storage: p.rateLimit.storage,
            redisClient: cache ? cache.getClient() : undefined,
          }),
        );
      }
    });

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

    metricsRegistry = new MetricsRegistry(HEALTHY_UPSTREAMS);

    lb = new LoadBalancer({
      strategy: ACTIVE_CONFIG.server.loadBalancing.strategy,
      upstreams: ACTIVE_CONFIG.server.upstreams,
      failureThreshold: ACTIVE_CONFIG.server.loadBalancing.failureThreshold,
      recoveryTimeMs: ACTIVE_CONFIG.server.loadBalancing.recoveryTimeMs,
      virtualNodes: ACTIVE_CONFIG.server.loadBalancing.virtualNodes,
      ewmaAlpha: ACTIVE_CONFIG.server.loadBalancing.ewmaAlpha,
      stickyCookieName: ACTIVE_CONFIG.server.loadBalancing.stickyCookieName,
      slowStartSeconds: ACTIVE_CONFIG.server.loadBalancing.slowStartSeconds,
    });

    registry.onRegister((service) => {
      HEALTHY_UPSTREAMS.add(service.id);
      lb.setHealthy(service.id, true);
    });

    ACTIVE_CONFIG.server.upstreams.forEach((u) => {
      registry.register({ id: u.id, url: u.url });
    });

    cluster.on("exit", (worker) => {
      const idx = WORKER_POOL.indexOf(worker);
      if (idx !== -1) {
        WORKER_POOL.splice(idx, 1);
        const newWorker = cluster.fork({
          APP_CONFIG: JSON.stringify(ACTIVE_CONFIG),
        });
        WORKER_POOL.push(newWorker);
      }
    });

    for (let i = 0; i < workerCount; i++) {
      const worker = cluster.fork({
        APP_CONFIG: JSON.stringify(ACTIVE_CONFIG),
      });
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

      let upstreamId: string | null = null;
      if (pathRule?.sticky) {
        const cookies = parseCookies(payload.headers.cookie);
        const stickId = cookies[ACTIVE_CONFIG.server.loadBalancing.stickyCookieName ?? "NINJA_ROUTE"];
        if (
          stickId &&
          HEALTHY_UPSTREAMS.has(stickId) &&
          !attemptedUpstreams.has(stickId)
        ) {
          upstreamId = stickId;
        }
      }

      if (!upstreamId) {
        upstreamId = lb.pickFiltered(
          HEALTHY_UPSTREAMS,
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
      metricsRegistry.recordActiveConnection(upstreamId, 1);
      lb.incrementConnection(upstreamId);

      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
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
      };

      const worker = WORKER_POOL[attempt % WORKER_POOL.length];
      if (!worker) {
        metricsRegistry.recordActiveConnection(upstreamId, -1);
        lb.releaseConnection(upstreamId);
        res.writeHead(500);
        res.end("No worker available");
        return;
      }

      const requestId = `${Date.now()}-${Math.random()}`;
      worker.send(
        JSON.stringify({
          ...enrichedPayload,
          requestId,
        }),
      );

      let timer: NodeJS.Timeout;
      const handler = async (raw: string) => {
        const parsed = JSON.parse(raw);
        if (parsed.requestId !== requestId) return;

        worker.off("message", handler);
        clearTimeout(timer);

        const reply = await workerMessageReplySchema.parseAsync(parsed);
        const retryConfig = ACTIVE_CONFIG.server.loadBalancing.retry;

        const errorStatus = reply.statusCode ?? 502;
        const isRetryable =
          reply.errorCode ||
          (reply.statusCode && retryConfig.statusCodes.includes(reply.statusCode));

        if (isRetryable) {
          logger.warn("Master", `Upstream failure: errorCode=${reply.errorCode}, status=${reply.statusCode}`, { upstreamId });
          lb.recordFailure(upstreamId!);

          const isLocalFailure = errorStatus === 500 || errorStatus === 502;
          const retryAllowed = globalRetryBudget.recordRetry();

          if (retryAllowed && attempt < retryConfig.maxAttempts) {
            if (isLocalFailure) {
              // Fast failover path - immediate retry
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
              // System Overload path - Exponential backoff with Full Jitter
              const baseDelayMs = ACTIVE_CONFIG.server.resilience?.retry?.baseDelayMs ?? 100;
              const maxDelayMs = ACTIVE_CONFIG.server.resilience?.retry?.maxDelayMs ?? 5000;
              const limit = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
              const jitterDelay = Math.random() * limit;

              logger.warn("Master", `Slowing down retries. Backing off for ${Math.round(jitterDelay)}ms`);

              setTimeout(() => {
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

          if (payload.requestType === "GET" && !reply.isCompressed) {
            const cacheKey = cache.buildKey(
              payload.requestType,
              new URL(payload.url, "http://dummy").pathname,
            );
            await cache.set(cacheKey, reply.data);
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
            Buffer.byteLength(responseData),
            performance.now() - startTime,
            (payload.headers["user-agent"] as string) ?? "-",
          );
        }
      };

      timer = setTimeout(() => {
        worker.off("message", handler);
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
      }, ACTIVE_CONFIG.server.readTimeoutMs);

      worker.on("message", handler);
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

      const HEALTHY_UPSTREAMS_SNAPSHOT = new Set(
        ACTIVE_CONFIG.server.upstreams.map((u) => u.id),
      );

      const upstreamId = lb.pickFiltered(
        HEALTHY_UPSTREAMS_SNAPSHOT,
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

      if (req.url === "/__cache-stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cache.getStats(), null, 2));
        return;
      }

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

      const url = new URL(req.url!, `https://${req.headers.host}`);
      const pathRule = ACTIVE_CONFIG.server.paths.find((p) =>
        url.pathname.startsWith(p.path),
      );

      if (pathRule?.rateLimit) {
        const routeLimiter = rateLimiters.get(pathRule.path);
        if (routeLimiter && !(await routeLimiter.isAllowed(clientIP))) {
          const retryAfter = Math.ceil(
            (routeLimiter.getResetTime(clientIP) - Date.now()) / 1000,
          );
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": retryAfter.toString(),
            "X-RateLimit-Limit": pathRule.rateLimit.maxRequests.toString(),
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
        const skipCache = url.pathname.startsWith("/api/upload/");
        if (!skipCache) {
          const cacheKey = cache.buildKey("GET", url.pathname);
          const cached = await cache.get(cacheKey);
          if (cached) {
            res.writeHead(200, { "X-Cache": "HIT" });
            res.end(cached);
            metricsRegistry.recordCacheOp("hit");
            metricsRegistry.recordRequest(
              "GET",
              req.url ?? "",
              200,
              "cache",
              0,
            );
            writeAccessLog(
              ACTIVE_CONFIG.server.accessLog,
              clientIP,
              req.method,
              req.url ?? "",
              200,
              Buffer.byteLength(cached),
              0,
              (req.headers["user-agent"] as string) ?? "-",
            );
            return;
          }
        }
      }

      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) {
        await cache.invalidate(url.pathname);
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
          requestType: (req.method ?? "GET") as WorkerMessageType["requestType"],
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
    });
  }
}
