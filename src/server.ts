import http from "http";
import https from "https";
import { readFileSync } from "fs";
import type { ConfigSchemaType } from "./config-schema.js";
import cluster, { Worker } from "node:cluster";
import { rootConfigSchema } from "./config-schema.js";
import { AutoScaler } from "./auto-scaler.js";

import type {
  WorkerMessageType,
  WorkerReplyMessageType,
} from "./server-schema.js";
import {
  workerMessageSchema,
  workerMessageReplySchema,
} from "./server-schema.js";

import { initialHealthCheck, startHealthChecks } from "./health.js";
import { RateLimiter } from "./rate-limiter.js";
import { LoadBalancer } from "./loadBalancer.js";
import { registry } from "./Serviceregistry.js";
import { Cache } from "./cache.js";

interface CreateServerConfig {
  port: number;
  workerCount: number;
  config: ConfigSchemaType;
}
const MAX_RETRIES = 2;

export async function createServer(config: CreateServerConfig) {
  const { port, workerCount } = config;
  const WORKER_POOL: Worker[] = [];

  const HEALTHY_UPSTREAMS: Set<string> = new Set(
    config.config.server.upstreams.map((e) => e.id)
  );
  if (cluster.isPrimary) {
    const sslOptions = {
      key: readFileSync("key.pem"),
      cert: readFileSync("cert.pem"),
    };
    const rateLimiters = new Map<string, RateLimiter>();
    config.config.server.paths.forEach((p) => {
      if (p.rateLimit) {
        rateLimiters.set(
          p.path,
          new RateLimiter({
            windowMs: p.rateLimit.windowMs,
            maxRequests: p.rateLimit.maxRequests,
          })
        );
      }
    });
    const cache = new Cache({
      enabled: config.config.server.cache.enabled,
      host: config.config.server.cache.host,
      port: config.config.server.cache.port,
      ttlSeconds: config.config.server.cache.ttlSeconds,
    });
    await cache.connect();

    const lb = new LoadBalancer({
      strategy: config.config.server.loadBalancing.strategy,
      upstreamIds: config.config.server.upstreams.map((u) => u.id),
      failureThreshold: config.config.server.loadBalancing.failureThreshold,
      recoveryTimeMs: config.config.server.loadBalancing.recoveryTimeMs,
    });
    registry.onRegister((service) => {
      HEALTHY_UPSTREAMS.add(service.id);
      if (!lb.hasUpstream(service.id)) {
        lb.addUpstream(service.id);
      }
      console.log(
        `[Master] New service added to LB: ${service.id} → ${service.url}`
      );
    });
    registry.onDeregister((service) => {
      console.log(`[DEBUG] Deregistering: ${service.id}`);
      if (service.status === "DOWN") {
        HEALTHY_UPSTREAMS.delete(service.id);
        lb.removeUpstream(service.id);
        console.log(`[Master] Service removed from LB: ${service.id}`);
      }
    });
    config.config.server.upstreams.forEach((u) => {
      registry.register({ id: u.id, url: u.url });
    });
    console.log(
      `[Master] Load balancing strategy: ${config.config.server.loadBalancing.strategy}`
    );
    cluster.on("online", (worker) => {
      console.log(`[Master] Worker PID ${worker.process.pid} is online`);
    });

    cluster.on("exit", (worker) => {
      console.log(
        `[Master] Worker PID ${worker.process.pid} died — replacing...`
      );
      const idx = WORKER_POOL.indexOf(worker);
      if (idx !== -1) WORKER_POOL.splice(idx, 1);
      const newWorker = cluster.fork({
        APP_CONFIG: JSON.stringify(config.config),  
      });
      WORKER_POOL.push(newWorker);
    });

    for (let i = 0; i < workerCount; i++) {
      const worker = cluster.fork({
        APP_CONFIG: JSON.stringify(config.config),
      });
      WORKER_POOL.push(worker);
    }

    function dispatchToWorker(
      payload: WorkerMessageType,
      clientIp: string,
      res: http.ServerResponse,
      attempt = 0
    ) {
      const upstreamId = lb.pick(HEALTHY_UPSTREAMS, clientIp);
      if (!upstreamId) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No healthy upstreams available" }));
        return;
      }
      const serviceInstance = registry.get(upstreamId);
      if (!serviceInstance) {
        res.writeHead(503);
        res.end("Service not found in registry");
        return;
      }
      const enrichedPayload: WorkerMessageType & {
        upstreamId: string;
        upstreamUrl: string;
      } = {
        ...payload,
        upstreamId,
        upstreamUrl: serviceInstance.url,
      };
   const WORKER_TIMEOUT = 20000;
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
        })
      );
      let timer: NodeJS.Timeout;
      const handler = async (raw: string) => {
        const parsed = JSON.parse(raw);
        if (parsed.requestId !== requestId) {
          return;
        }
        worker.off("message", handler);
        clearTimeout(timer);
        const reply = await workerMessageReplySchema.parseAsync(parsed);
        if (reply.errorCode) {
          lb.recordFailure(upstreamId);
          if (attempt < MAX_RETRIES) {
            dispatchToWorker(payload, clientIp, res, attempt + 1);
          } else {
            res.writeHead(parseInt(reply.errorCode));
            res.end(reply.error);
          }
        } else {
          lb.recordSuccess(upstreamId);
          if (payload.requestType === "GET") {
            const cacheKey = cache.buildKey(
              payload.requestType,
              new URL(payload.url, "http://dummy").pathname
            );
            await cache.set(cacheKey, reply.data);
          }
          res.writeHead(reply.statusCode ?? 200);
          res.end(reply.data);
        }
      };
      timer = setTimeout(() => {
        worker.off("message", handler);
        res.writeHead(504);
        res.end("Worker timeout");
      }, WORKER_TIMEOUT);

      worker.on("message", handler);
    }
    const autoScaler = config.config.server.autoScaling.enabled
      ? new AutoScaler(
          {
            minServers: config.config.server.autoScaling.minServers,
            maxServers: config.config.server.autoScaling.maxServers,
            scaleUpAt: config.config.server.autoScaling.scaleUpAt,
            scaleDownAt: config.config.server.autoScaling.scaleDownAt,
            cooldownMs: config.config.server.autoScaling.cooldownMs,
            startPort: config.config.server.autoScaling.startPort,
            proxyPort: config.config.server.autoScaling.proxyPort,
          },
          lb
        )
      : null;

    const httpServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/__registry")) {
        httpsServer.emit("request", req, res);
        return;
      }
      const httpsUrl = `https://${req.headers.host?.replace(
        String(port),
        String(config.config.server.httpsPort ?? 8443)
      )}${req.url}`;
      res.writeHead(301, { Location: httpsUrl });
      res.end();
    });

    const httpsServer = https.createServer(sslOptions, async (req, res) => {
      const clientIP =
        (req.headers["x-forwarded-for"] as string) ??
        req.socket.remoteAddress ??
        "unknown";

      if (req.url === "/__lb-stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              strategy: config.config.server.loadBalancing.strategy,
              upstreams: lb.getStats(),
              healthyUpstreams: [...HEALTHY_UPSTREAMS],
            },
            null,
            2
          )
        );
        return;
      }
      if (req.url === "/__autoscaler-stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(autoScaler?.getStats() ?? { enabled: false }, null, 2)
        );
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
              JSON.stringify({ message: `Service ${id} registered!`, service })
            );
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
          }
        });
        return;
      }
      if (
        req.url?.startsWith("/__registry/deregister/") &&
        req.method === "DELETE"
      ) {
        const id = req.url.replace("/__registry/deregister/", "");
        const success = registry.deregister(id);
        if (success) {
          res.writeHead(200);
          res.end(JSON.stringify({ message: `Service ${id} deregistered!` }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Service ${id} not found` }));
        }
        return;
      }
      if (
        req.url?.startsWith("/__registry/heartbeat/") &&
        req.method === "PUT"
      ) {
        const id = req.url.replace("/__registry/heartbeat/", "");
        const success = registry.heartbeat(id);
        res.writeHead(success ? 200 : 404);
        res.end(JSON.stringify({ ok: success }));
        return;
      }

      const url = new URL(req.url!, `https://${req.headers.host}`);
      const path = url.pathname;
      const routeLimiter = rateLimiters.get(path);
      if (routeLimiter && !routeLimiter.isAllowed(clientIP)) {
        const retryAfter = Math.ceil(
          (routeLimiter.getResetTime(clientIP) - Date.now()) / 1000
        );
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Remaining": "0",
        });
        res.end(
          JSON.stringify({
            error: "Too Many Requests",
            retryAfter: `${retryAfter}s`,
          })
        );
        return;
      }

      if (routeLimiter) {
        res.setHeader(
          "X-RateLimit-Remaining",
          routeLimiter.getRemainingRequests(clientIP).toString()
        );
      }
      if (req.method === "GET") {
        const cacheKey = cache.buildKey("GET", url.pathname);
        const cached = await cache.get(cacheKey);
        if (cached) {
          res.writeHead(200, {
            "X-Cache": "HIT",
          });
          res.end(cached);
          return;
        }
      }
      if (
        req.method === "POST" ||
        req.method === "PUT" ||
        req.method === "PATCH" ||
        req.method === "DELETE"
      ) {
        await cache.invalidate(url.pathname);
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload: WorkerMessageType = {
          requestType: (req.method ??
            "GET") as WorkerMessageType["requestType"],
          headers: req.headers,
          body: body || null,
          url: `${req.url}`,
        };
        dispatchToWorker(payload, clientIP, res);
      });
    });

    let isShuttingDown = false;
    async function gracefulShutdown(signal: string) {
      if (isShuttingDown) return;
      isShuttingDown = true;
      if (autoScaler) {
        autoScaler.stop();
      }
      console.log(
        `\n[Master] Received ${signal} — starting graceful shutdown...`
      );
      await cache.disconnect();
      httpServer.close(() => console.log("[Master] HTTP server closed"));
      httpsServer.close(() => {
        console.log("[Master] HTTPS server closed — all connections drained");
        process.exit(0);
      });
      setTimeout(() => {
        console.error("[Master] Forced exit after timeout");
        process.exit(1);
      }, 10_000);
    }

    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

    await new Promise((res) => setTimeout(res, 3000));
    await initialHealthCheck(config.config.server.upstreams, HEALTHY_UPSTREAMS);

    httpServer.listen(port, () => {
      console.log(`[Master] HTTP on port ${port} → redirects to HTTPS`);
    });
    httpsServer.listen(config.config.server.httpsPort ?? 8443, () => {
      console.log(
        `[Master] HTTPS on port ${config.config.server.httpsPort ?? 8443}`
      );
      startHealthChecks(config.config.server.upstreams, HEALTHY_UPSTREAMS);
      if (autoScaler) {
        autoScaler.start();
      }
    });
  } else {
    console.log(`[Worker ${process.pid}] Ready for work`);
    const workerConfig = await rootConfigSchema.parseAsync(
      JSON.parse(process.env.APP_CONFIG!)
    );
    process.on("message", async (message: string) => {
      const msg = await workerMessageSchema.parseAsync(JSON.parse(message));
      const raw = JSON.parse(message) as {
        upstreamId?: string;
        upstreamUrl?: string;
        requestId?: string;
      };
      const upstreamUrl: string | undefined = raw.upstreamUrl;

      const requestUrl = msg.url;
      const rule = workerConfig.server.paths.find((e) =>
        requestUrl.startsWith(e.path)
      );
      if (!rule) {
        const reply: WorkerReplyMessageType = {
          requestId: raw.requestId,
          errorCode: "404",
          error: "Route not found",
          data: "",
        };
        if (process.send) process.send(JSON.stringify(reply));
        return;
      }
      let finalUpstreamUrl: URL;
      if (upstreamUrl) {
        finalUpstreamUrl = new URL(upstreamUrl);
      } else {
        const upstream = workerConfig.server.upstreams.find(
          (e) => e.id === rule.upstream[0]
        );
        if (!upstream) {
          const reply: WorkerReplyMessageType = {
            requestId: raw.requestId,
            errorCode: "500",
            error: "Upstream not found",
            data: "",
          };
          if (process.send) process.send(JSON.stringify(reply));
          return;
        }
        finalUpstreamUrl = new URL(upstream.url);
      }
      const agent = new http.Agent({
        keepAlive: true,
        maxSockets: 5000,
      });
      const proxyReq = http.request(
        {
          host: finalUpstreamUrl.hostname,
          port: finalUpstreamUrl.port,
          path: requestUrl,
          method: msg.requestType,
          agent: agent,
          headers: {
            ...msg.headers,
            "X-Forwarded-For": msg.headers["x-forwarded-for"] || "unknown",
            "X-Real-IP": "127.0.0.1",
            "X-Proxy-By": "Ninja-Reverse-Proxy",
            ...(msg.body && {
              "Content-Length": Buffer.byteLength(msg.body).toString(),
            }),
          },
        },
        (upstreamRes) => {
          let body = "";
          const timeout = setTimeout(() => {
            const reply: WorkerReplyMessageType = {
              requestId: raw.requestId,
              errorCode: "500",
              error: "Gateway Timeout",
              data: "",
            };
            if (process.send) process.send(JSON.stringify(reply));
            proxyReq.destroy();
          }, 15000);
          upstreamRes.on("data", (chunk) => {
            body += chunk;
          });
          upstreamRes.on("end", () => {
            clearTimeout(timeout);
            const reply: WorkerReplyMessageType = {
              requestId: raw.requestId,
              data: body,
              error: "",
              statusCode: upstreamRes.statusCode ?? 200,
            };
            if (process.send) process.send(JSON.stringify(reply));
          });
        }
      );
      proxyReq.on("error", () => {
        const reply: WorkerReplyMessageType = {
          requestId: raw.requestId,
          errorCode: "500",
          error: "Upstream connection failed",
          data: "",
        };
        if (process.send) process.send(JSON.stringify(reply));
      });

      if (msg.body) proxyReq.write(msg.body);
      proxyReq.end();
    });
  }
}
