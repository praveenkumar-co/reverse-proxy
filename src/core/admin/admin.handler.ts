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
 * Ranges a registered upstream is never allowed to resolve to by default -- loopback,
 * RFC1918 private, link-local (covers the AWS/GCP/Azure metadata IP 169.254.169.254),
 * unspecified, multicast, and broadcast, for both IPv4 and IPv6, plus the AWS IMDSv2 IPv6
 * metadata address. `registrationAllowlist` (CIDRs or hosts, see isAllowlistedAddress below)
 * is the one way to exempt a specific address from this list -- e.g. a test harness that
 * legitimately needs to register 127.0.0.1.
 */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isDisallowedPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/, "");
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 0) return true; // 0.0.0.0/8 unspecified/"this network"
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
    if (normalized === "255.255.255.255") return true; // broadcast
    return false;
  }
  if (net.isIP(normalized) === 6) {
    const lower = normalized.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower === "::") return true; // unspecified
    if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
    if (lower === "fd00:ec2::254") return true; // AWS IMDSv2 metadata
    // fc00::/7 unique-local (fc00:: through fdff:...): first byte is 0xfc or 0xfd.
    const firstGroup = (lower.split(":")[0] ?? "").padStart(4, "0");
    const firstByte = parseInt(firstGroup.slice(0, 2), 16);
    if (firstByte === 0xfc || firstByte === 0xfd) return true;
    if (lower.startsWith("ff")) return true; // ff00::/8 multicast
    return false;
  }
  return false;
}

/** Parses "a.b.c.d/n" or "ipv6::/n" (or a bare address, treated as a /32 or /128) into a
 *  {testFn} that checks whether a given address falls inside it. Returns null if `cidr`
 *  isn't a CIDR/IP literal at all (i.e. it's meant to match as a hostname instead). */
function parseCidr(cidr: string): ((address: string) => boolean) | null {
  const [base = "", prefixStr] = cidr.split("/");
  const kind = net.isIP(base);
  if (kind === 0) return null;
  if (kind === 4) {
    const prefix = prefixStr !== undefined ? Number(prefixStr) : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const baseInt = ipv4ToInt(base);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address: string) => {
      const normalized = address.replace(/^::ffff:/, "");
      if (net.isIP(normalized) !== 4) return false;
      return (ipv4ToInt(normalized) & mask) === (baseInt & mask);
    };
  }
  // IPv6: compare the first `prefix` bits of the fully-expanded 128-bit address.
  const prefix = prefixStr !== undefined ? Number(prefixStr) : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const expand = (addr: string): bigint => {
    const buf = Buffer.alloc(16);
    let groups: string[];
    if (addr.includes("::")) {
      const left = (addr.split("::")[0] ?? "").split(":").filter(Boolean);
      const right = (addr.split("::")[1] ?? "").split(":").filter(Boolean);
      const missing = 8 - left.length - right.length;
      groups = [...left, ...Array(missing).fill("0"), ...right];
    } else {
      groups = addr.split(":");
    }
    for (let i = 0; i < 8; i++) {
      const val = parseInt(groups[i] || "0", 16) || 0;
      buf.writeUInt16BE(val, i * 2);
    }
    return (buf.readBigUInt64BE(0) << 64n) | buf.readBigUInt64BE(8);
  };
  const baseBig = expand(base);
  const maskBig = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
  return (address: string) => {
    const normalized = address.replace(/^::ffff:/, "");
    if (net.isIP(normalized) !== 6) return false;
    return (expand(normalized) & maskBig) === (baseBig & maskBig);
  };
}

/**
 * A denied (private/loopback/etc) address is still allowed if it's covered by an explicit
 * registrationAllowlist entry -- a CIDR ("127.0.0.1/32", "10.0.0.0/8") or bare IP matched
 * against the resolved address, or a hostname/domain-suffix (leading ".") matched against
 * the original hostname (for an allowlisted internal DNS name rather than a literal IP).
 */
function isAllowlistedAddress(address: string, hostname: string, allowlist: string[]): boolean {
  const lowerHost = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const matchesCidr = parseCidr(entry);
    if (matchesCidr) return matchesCidr(address);
    const e = entry.toLowerCase();
    return e.startsWith(".") ? lowerHost === e.slice(1) || lowerHost.endsWith(e) : lowerHost === e;
  });
}

/**
 * Validates a tenant-supplied upstream URL before the proxy ever registers (and later
 * dispatches real traffic to) it. Without this, POST /__registry/register accepted any URL,
 * letting a tenant point the proxy at an internal-only service or a cloud metadata endpoint
 * (e.g. 169.254.169.254) and read back whatever it returns through the proxy's own response.
 * Resolves the hostname via DNS rather than only pattern-matching the literal string, so a
 * DNS name that resolves to a blocked address can't bypass the check either. Returns the
 * validated address(es) so the caller can pin the registered upstream to them, defeating a
 * DNS-rebinding attack where the name resolves safely now but to a private address later.
 */
async function assertSafeRegistrationUrl(rawUrl: string, allowlist: string[]): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Scheme "${parsed.protocol}" is not allowed — only http/https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL must not contain userinfo (username/password)");
  }
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Port "${parsed.port}" is not a valid port number`);
    }
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
  for (const addr of addresses) {
    if (isDisallowedPrivateAddress(addr) && !isAllowlistedAddress(addr, parsed.hostname, allowlist)) {
      throw new Error(
        `Host "${parsed.hostname}" resolves to "${addr}", a loopback/private/link-local/unspecified/multicast/broadcast address, which is denied by default — add it to admin.registrationAllowlist to allow it`,
      );
    }
  }
  return addresses;
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
        let validatedAddresses: string[];
        try {
          validatedAddresses = await assertSafeRegistrationUrl(serviceUrl, config.admin.registrationAllowlist ?? []);
        } catch (err: any) {
          logger.warn("Admin", `Rejected unsafe upstream registration: ${err.message}`, { id, url: serviceUrl });
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        // Pins the upstream to the address(es) validated above (stored in metadata, read by
        // worker.ts's performUpstreamCall) so a DNS name that resolved safely at registration
        // time can't later be re-pointed at a private address and have the proxy's own next
        // real connection follow it there -- the validation above would otherwise only ever
        // run once, at registration, while every actual request re-resolves the hostname fresh.
        const service = await registry.register({
          id,
          url: serviceUrl,
          metadata: { ...(metadata ?? {}), pinnedAddress: validatedAddresses[0] },
        });
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
