import type http from "http";
import type { RootConfigType } from "../../config/schemas/server.schema.js";
import type { LoadBalancer } from "../../balancer/index.js";
import type { Cache } from "../../cache/cache-manager.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";
import { readinessProbe } from "../../observability/health/readiness.js";
import type { RetryBudget } from "../../resilience/retry/retry-budget.js";

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
