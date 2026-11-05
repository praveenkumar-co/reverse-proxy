import type http from "http";
import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import type { RootConfigType } from "../../config/schemas/server.schema.js";
import type { LoadBalancer } from "../../balancer/index.js";
import type { Cache } from "../../cache/cache-manager.js";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import type { ServiceInstance } from "../../discovery/registry/dynamic.registry.js";
import { readinessProbe } from "../../observability/health/readiness.js";
import type { RetryBudget } from "../../resilience/retry/retry-budget.js";
import { logger } from "../../observability/logger/logger.js";

/**
 * Decouples admin.handler.ts from the registry's physical location. Master owns the one real
 * ServiceRegistry; a worker (which is what actually serves /__* requests under the Phase B
 * architecture — see worker.ts) reads its own locally-broadcast mirror directly (getAll/get/
 * getStats are synchronous, no IPC) and forwards mutations (register/heartbeat/deregister) to
 * master over IPC, awaiting its reply before responding to the admin client.
 */
export interface RegistryClient {
  register(instance: { id: string; url: string; metadata?: Record<string, string> }): Promise<ServiceInstance>;
  deregister(id: string): Promise<boolean>;
  heartbeat(id: string): Promise<boolean>;
  getAll(): ServiceInstance[];
  get(id: string): ServiceInstance | undefined;
  getStats(): object;
}

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

/**
 * Link-local and cloud metadata ranges a registered upstream must never resolve to —
 * independent of any registrationAllowlist, since these exist specifically so an allowlist
 * misconfiguration (or a DNS name resolving there) can't still reach them.
 *   169.254.0.0/16  — IPv4 link-local, covers the AWS/GCP/Azure metadata IP 169.254.169.254
 *   fe80::/10       — IPv6 link-local
 *   fd00:ec2::254   — AWS IMDSv2 IPv6 metadata address
 */
function isLinkLocalOrMetadataAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/, "");
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 169 && parts[1] === 254;
  }
  if (net.isIP(normalized) === 6) {
    const lower = normalized.toLowerCase();
    return lower.startsWith("fe80:") || lower.startsWith("fe80::") || lower === "fd00:ec2::254";
  }
  return false;
}

function isAllowlistedHost(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const lower = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith(".") ? lower === e.slice(1) || lower.endsWith(e) : lower === e;
  });
}

/**
 * Validates a tenant-supplied upstream URL before the proxy ever registers (and later
 * dispatches real traffic to) it. Without this, POST /__registry/register accepted any URL,
 * letting a tenant point the proxy at an internal-only service or a cloud metadata endpoint
 * (e.g. 169.254.169.254) and read back whatever it returns through the proxy's own response.
 * Resolves the hostname via DNS rather than only pattern-matching the literal string, so a
 * DNS name that resolves to a blocked address can't bypass the check either.
 */
async function assertSafeRegistrationUrl(rawUrl: string, allowlist: string[]): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Scheme "${parsed.protocol}" is not allowed — only http/https`);
  }
  if (!isAllowlistedHost(parsed.hostname, allowlist)) {
    throw new Error(`Host "${parsed.hostname}" is not in the registration allowlist`);
  }
  const literalIpKind = net.isIP(parsed.hostname);
  const addresses: string[] = [];
  if (literalIpKind !== 0) {
    addresses.push(parsed.hostname);
  } else {
    try {
      const results = await dns.promises.lookup(parsed.hostname, { all: true, verbatim: true });
      addresses.push(...results.map((r) => r.address));
    } catch {
      throw new Error(`Could not resolve host "${parsed.hostname}"`);
    }
  }
  if (addresses.some((addr) => isLinkLocalOrMetadataAddress(addr))) {
    throw new Error(`Host "${parsed.hostname}" resolves to a link-local/metadata address, which is never allowed`);
  }
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
  registry: RegistryClient;
  // Invalidates `eventJson` (a Debezium-shaped CDC event) on every OTHER worker's own L1
  // cache and returns the total count purged there — see POST /__cdc/webhook below, which
  // has already invalidated its own L1 + the shared L2/Redis entry before calling this.
  broadcastCdcInvalidate: (eventJson: string) => Promise<number>;
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
    registry,
    broadcastCdcInvalidate,
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
    // Not merged separately here: collectWorkerMetricSnapshots() always returns every
    // worker's snapshot including this one's own (see worker.ts's implementation), so
    // merging metricsRegistry.getSnapshot() again on top would double-count this worker.
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

  // Entry point for CDC-driven cache invalidation: a Debezium HTTP sink (or a small Kafka
  // Connect / consumer bridge) posts the Debezium-shaped change event here. There is no Redis
  // pub/sub path for this — that was removed because it silently dropped events published
  // while the cache's Redis client was reconnecting (pub/sub has no replay or acknowledgment);
  // an HTTP POST at least gets a response the sender can retry on.
  //
  // The request lands on exactly one worker, but every worker keeps its own L1 (in-process)
  // cache layer, so a table change invisible to this worker's L1 would otherwise still be
  // served stale by every other worker. handleDebeziumEvent() below purges this worker's own
  // L1 and the shared L2/Redis entry; broadcastCdcInvalidate() fans the same event out to every
  // other worker (via the master) so their own L1 copies are purged too, and its count is
  // added to the total. Calling this twice with the identical event is a no-op the second time
  // (nothing left to invalidate) rather than an error.
  if (url === "/__cdc/webhook" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      try {
        const localCount = await cache.handleDebeziumEvent(body);
        const otherWorkersCount = await broadcastCdcInvalidate(body);
        const invalidated = localCount + otherWorkersCount;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ invalidated }));
      } catch (err: any) {
        logger.error("Admin", `CDC webhook failed: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error processing CDC event" }));
      }
    });
    return true;
  }

  if (url === "/__registry/register" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        const { id, url: serviceUrl, metadata } = JSON.parse(body);
        if (!id || !serviceUrl) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "id and url are required" }));
          return;
        }
        try {
          await assertSafeRegistrationUrl(serviceUrl, config.admin.registrationAllowlist ?? []);
        } catch (err: any) {
          logger.warn("Admin", `Rejected unsafe upstream registration: ${err.message}`, { id, url: serviceUrl });
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const service = await registry.register({ id, url: serviceUrl, metadata });
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
      const success = await registry.heartbeat(id);
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
      const success = await registry.deregister(id);
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
