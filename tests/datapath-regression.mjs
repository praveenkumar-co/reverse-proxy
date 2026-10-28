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
//
// All mock upstreams are started before the proxy boots (the proxy's initial
// health check would otherwise mark every upstream down). Exits 1 if any
// assertion fails.
// =============================================================================

import { spawn } from "node:child_process";
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
// Harness plumbing
// ----------------------------------------------------------------------------
const CONFIG_YAML = `
server:
  listen: ${PROXY_PORT}
  workers: 1
  compression: false
  maxResponseBytes: ${30 * 1024 * 1024}

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

loadBalancing:
  strategy: round-robin

resilience:
  retry:
    enabled: true
    maxAttempts: 0
  circuitBreaker:
    mode: classic
    failureThreshold: 3
    recoveryTimeMs: 1000
    maxHalfOpenProbes: 1

rateLimit:
  enabled: false

cache:
  enabled: false
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
