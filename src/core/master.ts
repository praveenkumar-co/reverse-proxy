import http from "http";
import https from "https";
import { readFileSync } from "fs";
import net from "net";
import type { ConfigSchemaType } from "../config/config-schema.js";
import cluster, { type Worker } from "node:cluster";

import {
  workerMessageReplySchema,
  type WorkerMessageType,
} from "../config/server-schema.js";

import { initialHealthCheck, startHealthChecks } from "../services/health.js";
import { RateLimiter } from "../middleware/rate-limiter.js";
import { LoadBalancer } from "../services/load-balancer.js";
import { registry } from "../services/registry.js";
import { Cache } from "../middleware/cache.js";
import { MetricsRegistry } from "../services/metrics.js";
import { writeAccessLog } from "../middleware/logger.js";
import { handleWebSocketUpgrade } from "./websocket.js";

interface CreateServerConfig {
  port: number;
  workerCount: number;
  config: ConfigSchemaType;
}

let WORKER_POOL: Worker[] = [];
let ACTIVE_CONFIG: ConfigSchemaType;
let lb: LoadBalancer;
let cache: Cache;
let metricsRegistry: MetricsRegistry;
const HEALTHY_UPSTREAMS: Set<string> = new Set();
const rateLimiters = new Map<string, RateLimiter>();

function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
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

export async function reloadServerConfig(newConfig: ConfigSchemaType) {
  console.log("[Master] Hot-reload initiated. Spawning replacement workers...");
  ACTIVE_CONFIG = newConfig;
  lb = new LoadBalancer({
    strategy: newConfig.server.loadBalancing.strategy,
    upstreams: newConfig.server.upstreams,
    failureThreshold: newConfig.server.loadBalancing.failureThreshold,
    recoveryTimeMs: newConfig.server.loadBalancing.recoveryTimeMs,
  });

  // Re-add dynamically registered services from registry
  registry.getAll().forEach((service) => {
    if (!lb.hasUpstream(service.id)) {
      lb.addUpstream(service.id, 1);
    }
  });

  const oldWorkers = [...WORKER_POOL];
  WORKER_POOL.length = 0;
  const targetWorkers = newConfig.server.workers ?? 2;

  for(let i = 0; i < targetWorkers; i++) {
    const worker = cluster.fork({
      APP_CONFIG: JSON.stringify(newConfig),
    });
    WORKER_POOL.push(worker);
  }

  console.log(`[Master] Retiring ${oldWorkers.length} old workers...`);
  for (const oldWorker of oldWorkers) {
    try {
      oldWorker.send(JSON.stringify({ type: "GRACEFUL_SHUTDOWN" }));
      setTimeout(() => {
        if (!oldWorker.isDead()) {
          oldWorker.kill("SIGTERM");
        }
      }, 15000);
    } catch {
      // ignore send errors for already-dead workers
    }
  }
}

export async function createServer(config: CreateServerConfig) {
  ACTIVE_CONFIG = config.config;
  const { port, workerCount } = config;

  ACTIVE_CONFIG.server.upstreams.map((e) => HEALTHY_UPSTREAMS.add(e.id));

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
          }),
        );
      }
    });

    cache = new Cache({
      enabled: ACTIVE_CONFIG.server.cache.enabled,
      host: ACTIVE_CONFIG.server.cache.host,
      port: ACTIVE_CONFIG.server.cache.port,
      ttlSeconds: ACTIVE_CONFIG.server.cache.ttlSeconds,
    });
    await cache.connect();

    metricsRegistry = new MetricsRegistry(HEALTHY_UPSTREAMS);

    lb = new LoadBalancer({
      strategy: ACTIVE_CONFIG.server.loadBalancing.strategy,
      upstreams: ACTIVE_CONFIG.server.upstreams,
      failureThreshold: ACTIVE_CONFIG.server.loadBalancing.failureThreshold,
      recoveryTimeMs: ACTIVE_CONFIG.server.loadBalancing.recoveryTimeMs,
    });

    registry.onRegister((service) => {
      HEALTHY_UPSTREAMS.add(service.id);
      if (!lb.hasUpstream(service.id)) {
        lb.addUpstream(service.id, 1);
      }
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
      const pathRule = ACTIVE_CONFIG.server.paths.find((p) =>
        payload.url.startsWith(p.path),
      );

      let upstreamId: string | null = null;
      if (pathRule?.sticky) {
        const cookies = parseCookies(payload.headers.cookie);
        const stickId = cookies["NINJA_ROUTE"];
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

      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
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
        if (
          reply.errorCode ||
          (reply.statusCode &&
            retryConfig.statusCodes.includes(reply.statusCode))
        ) {
          console.log(
            `[CircuitBreaker] Failure on ${upstreamId}: errorCode=${reply.errorCode}, status=${reply.statusCode}`,
          );
          lb.recordFailure(upstreamId!);
          if (attempt < retryConfig.maxAttempts) {
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            dispatchToWorker(
              payload,
              clientIp,
              res,
              attempt + 1,
              attemptedUpstreams,
              startTime,
            );
          } else {
            metricsRegistry.recordActiveConnection(upstreamId!, -1);
            res.writeHead(reply.statusCode ?? 502);
            res.end(reply.error || "Bad Gateway");
            metricsRegistry.recordRequest(
              payload.requestType,
              payload.url,
              reply.statusCode ?? 502,
              upstreamId!,
              performance.now() - startTime,
            );
            writeAccessLog(
              ACTIVE_CONFIG.server.accessLog,
              clientIp,
              payload.requestType,
              payload.url,
              reply.statusCode ?? 502,
              0,
              performance.now() - startTime,
              (payload.headers["user-agent"] as string) ?? "-",
            );
          }
        } else {
          lb.recordSuccess(upstreamId!);
          metricsRegistry.recordActiveConnection(upstreamId!, -1);
          metricsRegistry.recordRequest(
            payload.requestType,
            payload.url,
            reply.statusCode ?? 200,
            upstreamId!,
            performance.now() - startTime,
          );
          if (payload.requestType === "GET") {
            metricsRegistry.recordCacheOp("miss");
          }

          let responseData: Buffer | string = reply.data;
          if (reply.isCompressed && reply.encoding === "gzip") {
            responseData = Buffer.from(reply.data, "base64");
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
            responseHeaders["Set-Cookie"] =
              `NINJA_ROUTE=${upstreamId}; Path=/; HttpOnly; SameSite=Lax`;
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

    // WebSocket upgrade: pass config + lb so websocket.ts has no global state
    const wsUpgradeHandler = (
      req: http.IncomingMessage,
      socket: net.Socket,
      head: Buffer,
    ) => handleWebSocketUpgrade(req, socket, head, ACTIVE_CONFIG, lb);

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
        if (routeLimiter && !routeLimiter.isAllowed(clientIP)) {
          const retryAfter = Math.ceil(
            (routeLimiter.getResetTime(clientIP) - Date.now()) / 1000,
          );
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": retryAfter.toString(),
            "X-RateLimit-Remaining": "0",
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
      console.log(
        `\n[Master] Received ${signal} — draining and shutting down...`,
      );
      await cache.disconnect();
      httpServer.close();
      httpsServer.close(() => {
        process.exit(0);
      });
    }

    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

    await new Promise((res) => setTimeout(res, 3000));
    await initialHealthCheck(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS);

    httpServer.listen(port);
    httpsServer.listen(ACTIVE_CONFIG.server.httpsPort ?? 8443, () => {
      startHealthChecks(ACTIVE_CONFIG.server.upstreams, HEALTHY_UPSTREAMS, lb);
    });
  } else {
    // Worker process — handled entirely in core/worker.ts
  } 
}
