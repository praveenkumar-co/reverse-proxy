// =============================================================================
// DATAPATH REGRESSION SUITE
// =============================================================================
// Ports the 5 audit probes from docs/REMEDIATION_PLAN.md into executable
// assertions against the real built proxy (dist/, 1 worker) and local mock
// upstreams, over real HTTP — not unit tests against isolated classes.
//
//   1. Binary passthrough:        4096-byte random PNG, SHA-256 must match.
//   2. SSE time-to-first-byte:    upstream sends its first event at t=0;
//                                 client TTFB must be < 100 ms.
//   3. No duplicate POSTs:        1,500 concurrent POSTs with unique ids and
//                                 64 KB bodies; each id must reach the
//                                 upstream exactly once.
//   4. Large response integrity:  a 20 MB response must return 200 with
//                                 every byte intact.
//   5. Abort isolation:           3 client aborts against a healthy upstream
//                                 must not open the circuit breaker; the next
//                                 request must return 200, not 503.
//   6. Retry-buffer streaming:    a 5MB POST on a retry-eligible route (known
//                                 Content-Length over retryBufferLimitBytes)
//                                 skips buffering entirely; SHA-256 intact,
//                                 RSS growth across 20 concurrent requests
//                                 stays far below what full buffering would cost.
//   7. Retry-buffer replay:       a 100KB POST (under the limit) is still
//                                 fully buffered — the upstream's first-attempt
//                                 failure is retried once, with byte-identical
//                                 bodies both times, and the client sees 200.
//   8. Retry-buffer cutover:      a 5MB POST to a failing upstream is streamed
//                                 (not buffered) and therefore NOT retried —
//                                 client gets 502, upstream saw exactly 1 call.
//   9. Chunked overflow:          a chunked (no Content-Length) 3MB POST is
//                                 read incrementally, crosses retryBufferLimitBytes
//                                 mid-request, and switches to streaming with
//                                 no byte lost or duplicated (SHA-256 matches).
//  10. Route upstream isolation:  route B's upstream id is never registered
//                                 (missing/unhealthy pool). Every request to B
//                                 must get 503 and route A's healthy upstream
//                                 must receive none of them — a route must
//                                 never borrow another route's upstream.
//  11. Cache tenant isolation:    two different routes (two tenants) requesting
//                                 the same resource path-suffix and query string
//                                 must never observe each other's cached body.
//
// All mock upstreams are started before the proxy boots (the proxy's initial
// health check would otherwise mark every upstream down). Exits 1 if any
// assertion fails.
// =============================================================================

import { spawn, execSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const PROXY_PORT = 8591;
const UP_BINARY = 4701;
const UP_SSE = 4702;
const UP_POST = 4703;
const UP_LARGE = 4704;
const UP_ABORT = 4705;
const UP_RETRY_BIG = 4706; // shared by the big-body and chunked-overflow cases (two routes, one upstream)
const UP_RETRY_FLAKY_SMALL = 4707;
const UP_RETRY_FLAKY_BIG = 4708;
const UP_ROUTE_A = 4709;
const UP_CACHE_TENANT_A = 4710;
const UP_CACHE_TENANT_B = 4711;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? "\x1b[32m✅ PASS\x1b[0m" : "\x1b[31m❌ FAIL\x1b[0m";
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function startMock(port, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function consumeBody(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

// Health-check path is always "/" on every mock below; each test uses its own
// dedicated route/upstream so none of them share circuit-breaker state.
function withHealthCheck(testPath, handler) {
  return (req, res) => {
    const cleanPath = (req.url || "/").split("?")[0];
    if (cleanPath !== testPath) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    handler(req, res);
  };
}

function request(urlPath, { method = "GET", headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PROXY_PORT, path: urlPath, method, headers, agent },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

// ----------------------------------------------------------------------------
// Test 1: Binary passthrough — 4096-byte random PNG, SHA-256 must match.
// ----------------------------------------------------------------------------
const binaryPayload = crypto.randomBytes(4096);
binaryPayload[0] = 0x89;
binaryPayload[1] = 0x50;
binaryPayload[2] = 0x4e;
binaryPayload[3] = 0x47; // PNG magic bytes, rest random
const binaryExpectedSha = crypto.createHash("sha256").update(binaryPayload).digest("hex");

const binaryHandler = withHealthCheck("/binary", (req, res) => {
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": binaryPayload.length });
  res.end(binaryPayload);
});

async function testBinaryPassthrough() {
  const r = await request("/binary");
  const actualSha = crypto.createHash("sha256").update(r.body).digest("hex");
  record(
    "1. Binary passthrough: 4096-byte PNG SHA-256 matches",
    r.status === 200 && actualSha === binaryExpectedSha,
    `status=${r.status}, bytes=${r.body.length}/${binaryPayload.length}, sha-match=${actualSha === binaryExpectedSha}`,
  );
}

// ----------------------------------------------------------------------------
// Test 2: SSE time-to-first-byte < 100ms. Upstream sends its first event
// immediately, then a second event after a deliberate delay, then ends —
// so a buffer-until-upstream-closes proxy fails this even though the test
// terminates quickly, and a true streaming proxy passes easily.
// ----------------------------------------------------------------------------
const sseHandler = withHealthCheck("/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: first\n\n`);
  setTimeout(() => {
    res.write(`data: second\n\n`);
    res.end();
  }, 300);
});

async function testSseTtfb() {
  const result = await new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ttfbMs = -1;
    const req = http.request(
      { host: "127.0.0.1", port: PROXY_PORT, path: "/sse", method: "GET" },
      (res) => {
        res.on("data", () => {
          if (ttfbMs === -1) ttfbMs = performance.now() - t0;
        });
        res.on("end", () => resolve({ status: res.statusCode, ttfbMs }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
  record(
    "2. SSE time-to-first-byte < 100ms",
    result.status === 200 && result.ttfbMs >= 0 && result.ttfbMs < 100,
    `status=${result.status}, ttfb=${result.ttfbMs.toFixed(1)}ms`,
  );
}

// ----------------------------------------------------------------------------
// Test 3: 1,500 concurrent POSTs with unique ids and 64KB bodies — every id
// must reach the upstream exactly once (no IPC resend duplication).
// ----------------------------------------------------------------------------
const postDeliveryCounts = new Map();
const postHandler = withHealthCheck("/post-test", (req, res) => {
  consumeBody(req, (body) => {
    const id = req.headers["x-request-id"];
    postDeliveryCounts.set(id, (postDeliveryCounts.get(id) || 0) + 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, receivedBytes: body.length }));
  });
});

async function testNoDuplicatePosts() {
  const TOTAL = 1500;
  const BODY_SIZE = 64 * 1024;
  // Batched at a concurrency safely under this host's kernel accept-queue limit
  // (macOS kern.ipc.somaxconn defaults to 128) — bursting all 1,500 new
  // connections via one Promise.all overwhelms the TCP accept queue before the
  // proxy is even involved, producing client-side ECONNRESETs that have
  // nothing to do with the proxy's own correctness.
  const CONCURRENCY = 60;
  const bodyTemplate = crypto.randomBytes(BODY_SIZE);
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  const ids = Array.from({ length: TOTAL }, (_, i) => `req-${i}-${crypto.randomBytes(4).toString("hex")}`);

  for (let i = 0; i < TOTAL; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((id) =>
        request("/post-test", {
          method: "POST",
          headers: { "x-request-id": id, "Content-Type": "application/octet-stream" },
          body: bodyTemplate,
          agent,
        }).catch(() => null),
      ),
    );
  }
  agent.destroy();

  const uniqueIdsSeen = postDeliveryCounts.size;
  const duplicated = [...postDeliveryCounts.entries()].filter(([, count]) => count !== 1);
  record(
    "3. 1,500 concurrent POSTs: every id delivered exactly once",
    uniqueIdsSeen === TOTAL && duplicated.length === 0,
    `unique ids seen=${uniqueIdsSeen}/${TOTAL}, ids delivered != 1 time=${duplicated.length}` +
      (duplicated.length > 0 ? ` (e.g. ${duplicated[0][0]}=${duplicated[0][1]}x)` : ""),
  );
}

// ----------------------------------------------------------------------------
// Test 4: a 20MB response returns 200 with all bytes intact.
// ----------------------------------------------------------------------------
const LARGE_SIZE = 20 * 1024 * 1024;
const largePayload = crypto.randomBytes(LARGE_SIZE);
const largeExpectedSha = crypto.createHash("sha256").update(largePayload).digest("hex");
const largeHandler = withHealthCheck("/large", (req, res) => {
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": largePayload.length });
  res.end(largePayload);
});

async function testLargeResponse() {
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PROXY_PORT, path: "/large", method: "GET", timeout: 20000 },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on("data", (c) => {
            chunks.push(c);
            bytes += c.length;
          });
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), bytes }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
    const actualSha = r.body.length === LARGE_SIZE ? crypto.createHash("sha256").update(r.body).digest("hex") : null;
    record(
      "4. 20MB response returns 200 with all bytes intact",
      r.status === 200 && r.bytes === LARGE_SIZE && actualSha === largeExpectedSha,
      `status=${r.status}, bytes=${r.bytes}/${LARGE_SIZE}, sha-match=${actualSha === largeExpectedSha}`,
    );
  } catch (err) {
    record("4. 20MB response returns 200 with all bytes intact", false, `error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// Test 5: 3 client aborts against a healthy upstream must not open the
// circuit breaker — the next request must return 200, not 503.
// ----------------------------------------------------------------------------
let abortUpstreamCalls = 0;
const abortHandler = withHealthCheck("/abort-test", (req, res) => {
  abortUpstreamCalls++;
  // Hangs well past when the client severs the connection, so the proxy
  // observes a genuine client-initiated abort rather than a fast reply.
  setTimeout(() => {
    if (!res.writableEnded) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, calls: abortUpstreamCalls }));
    }
  }, 2000);
});

async function testAbortIsolation() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, path: "/abort-test", method: "GET" }, () => {});
      req.on("error", () => {});
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await sleep(150);
  }

  await sleep(300);
  const r = await request("/abort-test");
  record(
    "5. 3 client aborts do not trip the breaker — next request is 200",
    r.status === 200,
    `status=${r.status} (expected 200, not 503)`,
  );
}

// ----------------------------------------------------------------------------
// Tests 6-9: Step G — retry-safe body buffering switches to streaming once
// server.retryBufferLimitBytes (default 1 MiB) is exceeded, instead of
// buffering an arbitrarily large body just to make it replayable on retry.
// ----------------------------------------------------------------------------
function getProcessTreeRssKB(rootPid) {
  function getChildPids(pid) {
    try {
      return execSync(`pgrep -P ${pid}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    } catch {
      return [];
    }
  }
  const pids = [rootPid, ...getChildPids(rootPid)];
  try {
    const out = execSync(`ps -o rss= -p ${pids.join(",")}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n))
      .reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

function postWithIdempotency(urlPath, body, { headers = {}, agent } = {}) {
  return request(urlPath, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID(), "Content-Type": "application/octet-stream", ...headers },
    body,
    agent,
  });
}

// Sends `body` with no Content-Length header, writing it across multiple req.write()
// calls — Node's http client can't know the total length up front in that case, so it
// sends Transfer-Encoding: chunked automatically.
function postChunked(urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PROXY_PORT,
        path: urlPath,
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID(), "Content-Type": "application/octet-stream" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const CHUNK = 256 * 1024;
    let offset = 0;
    function writeMore() {
      while (offset < body.length) {
        const slice = body.subarray(offset, Math.min(offset + CHUNK, body.length));
        offset += slice.length;
        if (!req.write(slice)) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    }
    writeMore();
  });
}

// Shared by /retry-big (known-oversized Content-Length, test 6) and /retry-chunked
// (unknown length that overflows mid-request, test 9) — a route-level distinction, not
// an upstream one; both just hash whatever bytes they actually receive.
function retryBigOrChunkedHandler(req, res) {
  const cleanPath = (req.url || "/").split("?")[0];
  if (cleanPath !== "/retry-big" && cleanPath !== "/retry-chunked") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  req.on("data", (c) => {
    hash.update(c);
    bytes += c.length;
  });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sha256: hash.digest("hex"), bytes }));
  });
}

let flakySmallCalls = 0;
const flakySmallHashes = [];
function flakySmallHandler(req, res) {
  const cleanPath = (req.url || "/").split("?")[0];
  if (cleanPath !== "/retry-flaky-small") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  flakySmallCalls++;
  const callNum = flakySmallCalls;
  const hash = crypto.createHash("sha256");
  req.on("data", (c) => hash.update(c));
  req.on("end", () => {
    flakySmallHashes.push(hash.digest("hex"));
    if (callNum === 1) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated upstream failure" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, call: callNum }));
    }
  });
}

let flakyBigCalls = 0;
function flakyBigHandler(req, res) {
  const cleanPath = (req.url || "/").split("?")[0];
  if (cleanPath !== "/retry-flaky-big") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  flakyBigCalls++;
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "simulated upstream failure" }));
  });
}

async function testRetryBigBodyStreamedWithBoundedRss() {
  const SIZE = 5 * 1024 * 1024;
  const CONCURRENCY = 20;
  const bodies = Array.from({ length: CONCURRENCY }, () => crypto.randomBytes(SIZE));
  const expectedShas = bodies.map((b) => crypto.createHash("sha256").update(b).digest("hex"));

  await sleep(200);
  const baselineRssMB = getProcessTreeRssKB(proxyProc.pid) / 1024;
  let peakRssMB = baselineRssMB;
  const sampler = setInterval(() => {
    const rss = getProcessTreeRssKB(proxyProc.pid) / 1024;
    if (rss > peakRssMB) peakRssMB = rss;
  }, 25);

  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  const results = await Promise.all(
    bodies.map((b) => postWithIdempotency("/retry-big", b, { agent }).catch((err) => ({ error: err.message }))),
  );
  agent.destroy();
  clearInterval(sampler);

  const growthMB = peakRssMB - baselineRssMB;
  const allOk = results.every((r, i) => {
    if (!r || r.error) return false;
    try {
      const parsed = JSON.parse(r.body.toString("utf8"));
      return r.status === 200 && parsed.sha256 === expectedShas[i] && parsed.bytes === SIZE;
    } catch {
      return false;
    }
  });
  const naiveFullBufferMB = (SIZE * CONCURRENCY) / 1024 / 1024;
  record(
    "6. 5MB POST x20 concurrent on a retry-eligible route: SHA-256 matches, RSS growth well under naive full-buffering",
    allOk && growthMB < 50,
    `all 20 SHA-256 matched=${allOk}, RSS growth=${growthMB.toFixed(1)}MB (naive full-buffer of all 20 bodies would be ~${naiveFullBufferMB}MB)`,
  );
}

async function testRetryFlakySmallRetriedOnce() {
  flakySmallCalls = 0;
  flakySmallHashes.length = 0;
  const SIZE = 100 * 1024;
  const body = crypto.randomBytes(SIZE);
  const expectedSha = crypto.createHash("sha256").update(body).digest("hex");

  const r = await postWithIdempotency("/retry-flaky-small", body);
  const bothAttemptsIdentical = flakySmallHashes.length === 2 && flakySmallHashes.every((h) => h === expectedSha);
  record(
    "7. 100KB POST retried once after upstream fails first attempt: identical bytes both times, client gets 200",
    r.status === 200 && flakySmallCalls === 2 && bothAttemptsIdentical,
    `status=${r.status}, upstream calls=${flakySmallCalls}, both attempts byte-identical=${bothAttemptsIdentical}`,
  );
}

async function testRetryBigBodyNotRetried() {
  flakyBigCalls = 0;
  const SIZE = 5 * 1024 * 1024;
  const body = crypto.randomBytes(SIZE);

  const r = await postWithIdempotency("/retry-flaky-big", body);
  record(
    "8. 5MB POST to a failing upstream on a retry-eligible route: streamed (not buffered) so NOT retried — client gets 502, upstream saw exactly 1 attempt",
    r.status === 502 && flakyBigCalls === 1,
    `status=${r.status}, upstream calls=${flakyBigCalls}`,
  );
}

async function testRetryChunkedBodyOverflow() {
  const SIZE = 3 * 1024 * 1024;
  const body = crypto.randomBytes(SIZE);
  const expectedSha = crypto.createHash("sha256").update(body).digest("hex");

  const r = await postChunked("/retry-chunked", body);
  let parsed;
  try {
    parsed = JSON.parse(r.body.toString("utf8"));
  } catch {}
  record(
    "9. Chunked (no Content-Length) 3MB POST crosses retryBufferLimitBytes mid-request: streamed, SHA-256 matches",
    r.status === 200 && parsed?.sha256 === expectedSha && parsed?.bytes === SIZE,
    `status=${r.status}, sha-match=${parsed?.sha256 === expectedSha}, bytes=${parsed?.bytes}/${SIZE}`,
  );
}

// ----------------------------------------------------------------------------
// Test 10: route upstream isolation — /route-b's upstream id ("ghost-upstream")
// is never registered in the proxy's upstreams list (just like a tenant's
// dynamic upstream that hasn't been registered via the admin API yet). Every
// request to /route-b must get 503, and /route-a's healthy, fully distinct
// upstream must never see any of that traffic.
// ----------------------------------------------------------------------------
let routeAUpstreamCalls = 0;
const routeAHandler = withHealthCheck("/route-a", (req, res) => {
  routeAUpstreamCalls++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "route-a-backend" }));
});

async function testRouteUpstreamIsolation() {
  routeAUpstreamCalls = 0;
  const TOTAL = 200;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 20 });
  const results = await Promise.all(
    Array.from({ length: TOTAL }, () => request("/route-b", { agent }).catch((err) => ({ error: err.message }))),
  );
  agent.destroy();
  const non503 = results.filter((r) => r.status !== 503);
  record(
    "10. Route upstream isolation: route B's unregistered upstream never borrows route A's upstream",
    non503.length === 0 && routeAUpstreamCalls === 0,
    `${TOTAL} requests to /route-b: non-503=${non503.length} (expected 0), route-a-backend received=${routeAUpstreamCalls} (expected 0)`,
  );
}

// ----------------------------------------------------------------------------
// Test 11: cache tenant isolation — two different routes (two tenants) request
// the same resource path-suffix and the same query string. Each tenant's cache
// entry must reflect only its own upstream's body, never the other tenant's.
// ----------------------------------------------------------------------------
function tenantCacheHandler(tenantId) {
  return withHealthCheck(`/${tenantId}/resource`, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300" });
    res.end(JSON.stringify({ tenant: tenantId, url: req.url }));
  });
}

async function testCacheTenantIsolation() {
  const QUERY = "?id=42";
  // First round populates each tenant's cache entry (MISS); second round must hit it back
  // with that same tenant's body — never the other tenant's, even though the resource
  // suffix and query string are identical across both routes.
  const a1 = await request(`/tenant-a/resource${QUERY}`);
  const b1 = await request(`/tenant-b/resource${QUERY}`);
  const a2 = await request(`/tenant-a/resource${QUERY}`);
  const b2 = await request(`/tenant-b/resource${QUERY}`);
  const parse = (r) => {
    try {
      return JSON.parse(r.body.toString("utf8"));
    } catch {
      return null;
    }
  };
  const pa1 = parse(a1);
  const pa2 = parse(a2);
  const pb1 = parse(b1);
  const pb2 = parse(b2);
  const tenantAIsolated = pa1?.tenant === "tenant-a" && pa2?.tenant === "tenant-a";
  const tenantBIsolated = pb1?.tenant === "tenant-b" && pb2?.tenant === "tenant-b";
  const secondCallsCached = a2.headers["x-cache"] === "HIT" && b2.headers["x-cache"] === "HIT";
  record(
    "11. Cache tenant isolation: same resource path-suffix and query on two different routes never share a cache entry",
    tenantAIsolated && tenantBIsolated && secondCallsCached,
    `tenant-a bodies=[${pa1?.tenant},${pa2?.tenant}], tenant-b bodies=[${pb1?.tenant},${pb2?.tenant}], ` +
      `a2 x-cache=${a2.headers["x-cache"]}, b2 x-cache=${b2.headers["x-cache"]}`,
  );
}

// ----------------------------------------------------------------------------
// Harness plumbing
// ----------------------------------------------------------------------------
const CONFIG_YAML = `
server:
  listen: ${PROXY_PORT}
  workers: 1
  compression: false
  maxResponseBytes: ${30 * 1024 * 1024}
  # Default is 1 MiB — spelled out explicitly since the retry-buffer tests assert
  # behavior on both sides of this exact threshold (100KB under it, 3MB/5MB over it).
  retryBufferLimitBytes: ${1 * 1024 * 1024}

tls:
  enabled: false

observability:
  logging:
    level: warn
    accessLog: false

admin:
  enabled: false

upstreams:
  - id: binary-backend
    url: "http://127.0.0.1:${UP_BINARY}"
    healthPath: "/"
  - id: sse-backend
    url: "http://127.0.0.1:${UP_SSE}"
    healthPath: "/"
  - id: post-backend
    url: "http://127.0.0.1:${UP_POST}"
    healthPath: "/"
  - id: large-backend
    url: "http://127.0.0.1:${UP_LARGE}"
    healthPath: "/"
  - id: abort-backend
    url: "http://127.0.0.1:${UP_ABORT}"
    healthPath: "/"
  - id: retry-big-backend
    url: "http://127.0.0.1:${UP_RETRY_BIG}"
    healthPath: "/"
  - id: retry-flaky-small-backend
    url: "http://127.0.0.1:${UP_RETRY_FLAKY_SMALL}"
    healthPath: "/"
  - id: retry-flaky-big-backend
    url: "http://127.0.0.1:${UP_RETRY_FLAKY_BIG}"
    healthPath: "/"
  - id: route-a-backend
    url: "http://127.0.0.1:${UP_ROUTE_A}"
    healthPath: "/"
  - id: cache-tenant-a-backend
    url: "http://127.0.0.1:${UP_CACHE_TENANT_A}"
    healthPath: "/"
  - id: cache-tenant-b-backend
    url: "http://127.0.0.1:${UP_CACHE_TENANT_B}"
    healthPath: "/"

routes:
  - path: "/binary"
    upstreams: ["binary-backend"]
    cache: { enabled: false }
  - path: "/sse"
    upstreams: ["sse-backend"]
    cache: { enabled: false }
  - path: "/post-test"
    upstreams: ["post-backend"]
    cache: { enabled: false }
  - path: "/large"
    upstreams: ["large-backend"]
    cache: { enabled: false }
  - path: "/abort-test"
    upstreams: ["abort-backend"]
    cache: { enabled: false }
  - path: "/retry-big"
    upstreams: ["retry-big-backend"]
    cache: { enabled: false }
  - path: "/retry-chunked"
    upstreams: ["retry-big-backend"]
    cache: { enabled: false }
  - path: "/retry-flaky-small"
    upstreams: ["retry-flaky-small-backend"]
    cache: { enabled: false }
  - path: "/retry-flaky-big"
    upstreams: ["retry-flaky-big-backend"]
    cache: { enabled: false }
  - path: "/route-a"
    upstreams: ["route-a-backend"]
    cache: { enabled: false }
  - path: "/route-b"
    # "ghost-upstream" is deliberately absent from the upstreams: list above — same
    # shape as a tenant's dynamic upstream that hasn't been registered via the admin
    # API yet. This route must 503, never borrow route-a-backend (F, Step 1 / P0).
    upstreams: ["ghost-upstream"]
    cache: { enabled: false }
  - path: "/tenant-a/resource"
    upstreams: ["cache-tenant-a-backend"]
    cache: { enabled: true, ttlSeconds: 300 }
  - path: "/tenant-b/resource"
    upstreams: ["cache-tenant-b-backend"]
    cache: { enabled: true, ttlSeconds: 300 }

loadBalancing:
  strategy: round-robin
  retry:
    maxAttempts: 2
    statusCodes: [502, 503, 504]

resilience:
  retry:
    enabled: true
    maxAttempts: 2
    retryOn:
      localNodeFailure: true
      systemOverload: true
  circuitBreaker:
    mode: classic
    failureThreshold: 3
    recoveryTimeMs: 1000
    maxHalfOpenProbes: 1

rateLimit:
  enabled: false

cache:
  enabled: true
  l1Enabled: true
`;

const tmpConfigPath = path.join(os.tmpdir(), `ninja-datapath-regression-${process.pid}.yaml`);
let proxyProc;
let mockServers = [];
let cleanedUp = false;

function log(msg) {
  console.log(`[datapath-regression] ${msg}`);
}

async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/binary", method: "GET", timeout: 1000 }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      });
      req.on("error", (err) => resolve({ error: err }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ error: new Error("timeout") });
      });
      req.end();
    });
    if (result.status === 200) return;
    lastErr = result.error ?? new Error(`unexpected status ${result.status}`);
    await sleep(250);
  }
  throw new Error(`Proxy never became ready on port ${port} within ${timeoutMs}ms (last: ${lastErr?.message})`);
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  log("Tearing down...");
  for (const s of mockServers) {
    try {
      await new Promise((r) => s.close(r));
    } catch {}
  }
  if (proxyProc && proxyProc.exitCode === null && !proxyProc.killed) {
    proxyProc.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => proxyProc.once("exit", () => resolve(true))),
      sleep(3000).then(() => false),
    ]);
    if (!exited) {
      try {
        proxyProc.kill("SIGKILL");
      } catch {}
    }
  }
  try {
    fs.unlinkSync(tmpConfigPath);
  } catch {}
}

function printSummary() {
  console.log("\n================================================================================");
  console.log("  DATAPATH REGRESSION SUITE — RESULTS");
  console.log("================================================================================");
  for (const r of results) {
    const icon = r.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    console.log(`  ${icon} ${r.name}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log("--------------------------------------------------------------------------------");
  console.log(`  RESULT: ${passed}/${results.length} PASSED`);
  console.log("================================================================================\n");
}

async function main() {
  log("Starting mock upstreams...");
  mockServers = await Promise.all([
    startMock(UP_BINARY, binaryHandler),
    startMock(UP_SSE, sseHandler),
    startMock(UP_POST, postHandler),
    startMock(UP_LARGE, largeHandler),
    startMock(UP_ABORT, abortHandler),
    startMock(UP_RETRY_BIG, retryBigOrChunkedHandler),
    startMock(UP_RETRY_FLAKY_SMALL, flakySmallHandler),
    startMock(UP_RETRY_FLAKY_BIG, flakyBigHandler),
    startMock(UP_ROUTE_A, routeAHandler),
    startMock(UP_CACHE_TENANT_A, tenantCacheHandler("tenant-a")),
    startMock(UP_CACHE_TENANT_B, tenantCacheHandler("tenant-b")),
  ]);
  log(`${mockServers.length} mock upstreams ready.`);

  log("Writing regression config...");
  fs.writeFileSync(tmpConfigPath, CONFIG_YAML, "utf8");

  log(`Starting proxy (1 worker), listening on ${PROXY_PORT}...`);
  const proxyLogPath = path.join(os.tmpdir(), `ninja-datapath-regression-proxy-${process.pid}.log`);
  const proxyLogFd = fs.openSync(proxyLogPath, "a");
  proxyProc = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", tmpConfigPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", proxyLogFd, proxyLogFd],
    env: { ...process.env },
  });
  proxyProc.on("exit", (code, signal) => {
    if (!cleanedUp) {
      log(`\x1b[31mProxy exited unexpectedly (code=${code}, signal=${signal}). See log: ${proxyLogPath}\x1b[0m`);
    }
  });

  await waitForReady(PROXY_PORT, 20000);
  log(`Proxy ready. (log: ${proxyLogPath})\n`);

  await testBinaryPassthrough();
  await testSseTtfb();
  await testNoDuplicatePosts();
  await testLargeResponse();
  await testAbortIsolation();
  await testRetryBigBodyStreamedWithBoundedRss();
  await testRetryFlakySmallRetriedOnce();
  await testRetryBigBodyNotRetried();
  await testRetryChunkedBodyOverflow();
  await testRouteUpstreamIsolation();
  await testCacheTenantIsolation();

  printSummary();

  const allPassed = results.every((r) => r.passed);
  process.exitCode = allPassed ? 0 : 1;
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  await main();
} catch (err) {
  console.error(`[datapath-regression] FATAL: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
