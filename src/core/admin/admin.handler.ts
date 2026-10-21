import type http from "http";
import crypto from "node:crypto";
import type { RootConfigType } from "../../config/schemas/server.schema.js";
import type { LoadBalancer } from "../../balancer/index.js";
import type { Cache } from "../../cache/cache-manager.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";
import { readinessProbe } from "../../observability/health/readiness.js";
import type { RetryBudget } from "../../resilience/retry/retry-budget.js";
import { logger } from "../../observability/logger/logger.js";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractAdminToken(req: http.IncomingMessage): string | undefined {
  const headerToken = req.headers["x-admin-token"];
  if (typeof headerToken === "string" && headerToken.length > 0) return headerToken;
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.length > 0) return token;
  }
  return undefined;
}

/**
 * Fails closed: if admin is enabled but no secret is configured (config `admin.token`
 * or ADMIN_SECRET env var), every admin request is rejected rather than left open.
 */
function isAuthorizedAdminRequest(req: http.IncomingMessage, config: RootConfigType): boolean {
  const expected = config.admin.token;
  if (!expected) return false;
  const provided = extractAdminToken(req);
  if (!provided) return false;
  return safeCompare(provided, expected);
}

export interface AdminHandlerOptions {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  config: RootConfigType;
  lb: LoadBalancer;
  healthyUpstreams: Set<string>;
  retryBudget: RetryBudget;
  metricsRegistry: MetricsRegistry;
  cache: Cache;
  collectWorkerMetricSnapshots: () => Promise<any[]>;
}

/**
 * Handles administrative and monitoring endpoints.
 * Returns true if the request was an admin request and was handled; false otherwise.
 */
export async function handleAdminRequest(options: AdminHandlerOptions): Promise<boolean> {
  const {
    req,
    res,
    config,
    lb,
    healthyUpstreams,
    retryBudget,
    metricsRegistry,
    cache,
    collectWorkerMetricSnapshots,
  } = options;

  const url = req.url ?? "/";
  const isAdminPath = url.startsWith("/__");

  if (isAdminPath) {
    if (!config.admin.enabled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return true;
    }
    if (!isAuthorizedAdminRequest(req, config)) {
      logger.warn("Admin", `Rejected unauthorized admin request: ${req.method} ${url}`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return true;
    }
  }

  if (url === "/__lb-stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          strategy: config.server.loadBalancing.strategy,
          upstreams: lb.getStats(),
          healthyUpstreams: [...healthyUpstreams],
          retryBudget: retryBudget.getStats(),
        },
        null,
        2,
      ),
    );
    return true;
  }

  if (url.startsWith("/metrics") || url.startsWith("/__metrics")) {
    const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
    const tenantFilter = parsedUrl.searchParams.get("tenant") || undefined;
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
    const snapshots = await collectWorkerMetricSnapshots();
    const allUpstreams = [
      ...new Set([
        ...config.server.upstreams.map((u) => u.id),
        ...registry.getAll().map((s) => s.id),
      ]),
    ];
    const aggregatedRegistry = new MetricsRegistry(healthyUpstreams);
    aggregatedRegistry.mergeSnapshot(metricsRegistry.getSnapshot());
    for (const snap of snapshots) {
      aggregatedRegistry.mergeSnapshot(snap);
    }
    res.end(aggregatedRegistry.getExpositionFormat(allUpstreams, tenantFilter));
    return true;
  }

  if (url === "/__registry") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(registry.getStats(), null, 2));
    return true;
  }

  if (url === "/__ready" || url === "/__health") {
    const result = await readinessProbe.isReady();
    res.writeHead(result.ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  if (url === "/__cache-stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cache.getStats(), null, 2));
    return true;
  }

  if (url === "/__cache/purge/tag" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        const { tag } = JSON.parse(body);
        if (!tag || typeof tag !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "tag is required" }));
          return;
        }
        const keys = await cache.purgeByTag(tag);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tag, purgedKeys: keys.length, keys }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return true;
  }

  if (url === "/__cache/purge/pattern" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        const { pattern } = JSON.parse(body);
        if (!pattern || typeof pattern !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "pattern is required" }));
          return;
        }
        await cache.purgeByPattern(pattern);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pattern, status: "purged" }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return true;
  }

  if (url === "/__registry/register" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const { id, url: serviceUrl, metadata } = JSON.parse(body);
        if (!id || !serviceUrl) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "id and url are required" }));
          return;
        }
        const service = registry.register({ id, url: serviceUrl, metadata });
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
    return true;
  }

  if (url.startsWith("/__registry/heartbeat/") && req.method === "PUT") {
    const id = url.substring("/__registry/heartbeat/".length);
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
    return true;
  }

  if (url.startsWith("/__registry/deregister/") && req.method === "DELETE") {
    const id = url.substring("/__registry/deregister/".length);
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
    return true;
  }

  return false;
}
