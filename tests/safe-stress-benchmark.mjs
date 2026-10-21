// =============================================================================
// SAFE PRODUCTION CAPACITY STRESS BENCHMARK — EXTREME TIER PROFILE
// =============================================================================
// Boots an in-memory mock upstream + the reverse proxy (dist/index.js) as
// separate child processes, then runs a 3-tier concurrency ramp against the
// proxy using a bounded, keep-alive HTTP client (no external load-test
// dependency required). Every tier is safety-monitored in real time: if the
// rolling p95 latency or error rate breaches the configured threshold, the
// ramp halts immediately rather than continuing to climb.
//
// Hardware-safety profile for this run:
//   - 6 proxy worker processes (leaves 4 of this machine's 10 cores free for
//     macOS/WindowServer and the load generator itself).
//   - WARN-level proxy logging (the per-request "Routed GET ..." INFO log
//     identified as an event-loop bottleneck in the prior run is suppressed).
//   - TCP listen() backlog raised to 8192 so a burst of simultaneous new
//     connections isn't dropped/reset at the OS accept-queue layer.
//
// This does NOT use literal wire-level HTTP/1.1 pipelining for Tier 3 — Node's
// http client does not support that safely (out-of-order response matching),
// and the Node docs themselves advise against it. "Maximum Saturation" is
// instead approximated as the bounded-connection-pool tier running at its
// full socket cap, which is the same mechanism autocannon itself uses by
// default (N persistent connections, each issuing requests back-to-back).
// =============================================================================

import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------
const MOCK_PORT = 3101;
const PROXY_PORT = 8099;
const LISTEN_BACKLOG = 8192;
const MAX_SOCKETS_HARD_CAP = 2000;
const LATENCY_ABORT_MS = 500; // emergency brake: rolling p95 latency
const ERROR_RATE_ABORT = 0.05; // emergency brake: rolling error rate (5%)
const BRAKE_GRACE_MS = 1000; // ignore brake checks for the first second of a tier (connection ramp-up noise)
const BRAKE_MIN_SAMPLES = 20; // don't evaluate the brake on a near-empty window
const REQUEST_TIMEOUT_MS = 2000;
const INTER_TIER_COOLDOWN_MS = 3000;
// Fixed per this run's hardware-safety directive: leaves 4 of 10 cores free for
// macOS/WindowServer and the load generator, rather than deriving from CPU count.
const PROXY_WORKERS = 6;

const TIERS = [
  { name: "Tier 1: 500 Connections", connections: 500, durationMs: 10_000 },
  { name: "Tier 2: 1,000 Connections", connections: 1000, durationMs: 10_000 },
  { name: "Tier 3: 2,000 Connections", connections: 2000, durationMs: 10_000 },
];

for (const t of TIERS) {
  if (t.connections > MAX_SOCKETS_HARD_CAP) {
    throw new Error(`Refusing to configure ${t.name} above the ${MAX_SOCKETS_HARD_CAP}-socket safety cap`);
  }
}

const tmpConfigPath = path.join(os.tmpdir(), `ninja-stress-config-${process.pid}.yaml`);

let mockProc;
let proxyProc;
let cleanedUp = false;

// ----------------------------------------------------------------------------
// Mock upstream: instant 200 OK, tiny JSON body. Run as a separate process so
// its event loop never competes with the load generator's, and so it can be
// torn down via SIGTERM independently of the proxy, per the safety spec.
// ----------------------------------------------------------------------------
const MOCK_SOURCE = `
const http = require('http');
const port = ${MOCK_PORT};
const body = Buffer.from(JSON.stringify({ status: 'ok' }));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
});
server.keepAliveTimeout = 60000;
server.maxConnections = 20000;
server.on('error', (err) => { console.error('MOCK_ERROR', err.message); process.exit(1); });
server.listen(port, '127.0.0.1', ${LISTEN_BACKLOG}, () => { console.log('MOCK_READY'); });
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
`;

const STRESS_CONFIG_YAML = `
server:
  listen: ${PROXY_PORT}
  workers: ${PROXY_WORKERS}
  trustProxy: true
  compression: false
  backlog: ${LISTEN_BACKLOG}

tls:
  enabled: false

observability:
  logging:
    level: warn
    accessLog: false

upstreams:
  - id: mock
    url: "http://127.0.0.1:${MOCK_PORT}"
    weight: 1
    healthPath: "/"

routes:
  - path: "/"
    upstreams: ["mock"]
    cache:
      enabled: false

loadBalancing:
  strategy: least-connections

resilience:
  retry:
    enabled: true
  circuitBreaker:
    mode: classic
    failureThreshold: 50
  bulkhead:
    enabled: false

rateLimit:
  enabled: false

cache:
  enabled: false

admin:
  enabled: false
`;

function log(msg) {
  console.log(`[benchmark] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForStdout(child, marker, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not print "${marker}" within ${timeoutMs}ms. Output so far:\n${buf}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(marker)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
  });
}

async function waitForHttp200(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1000 }, (res) => {
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
  throw new Error(`${label} never returned HTTP 200 on port ${port} within ${timeoutMs}ms (last: ${lastErr?.message})`);
}

function getChildPids(pid) {
  try {
    return execSync(`pgrep -P ${pid}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when there are no matching children
  }
}

function getProcessTreeRssKB(rootPid) {
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

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[idx];
}

async function runTier(tier) {
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: tier.connections,
    maxFreeSockets: tier.connections,
  });

  const latencies = [];
  let success2xx = 0;
  let errorCount = 0;
  const secondBuckets = new Map(); // second-index -> request count, for Max RPS
  let windowSamples = [];

  let aborted = false;
  let abortReason = null;

  const tierStart = Date.now();
  const endAt = tierStart + tier.durationMs;
  const graceUntil = tierStart + BRAKE_GRACE_MS;

  const monitor = setInterval(() => {
    const now = Date.now();
    const cutoff = now - 1000;
    windowSamples = windowSamples.filter((s) => s.t >= cutoff);
    if (now < graceUntil || windowSamples.length < BRAKE_MIN_SAMPLES) return;
    const errs = windowSamples.filter((s) => !s.ok).length;
    const errRate = errs / windowSamples.length;
    const lat = windowSamples.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = percentile(lat, 95);
    if (errRate > ERROR_RATE_ABORT) {
      aborted = true;
      abortReason = `rolling error rate ${(errRate * 100).toFixed(1)}% exceeded ${ERROR_RATE_ABORT * 100}%`;
    } else if (p95 > LATENCY_ABORT_MS) {
      aborted = true;
      abortReason = `rolling p95 latency ${p95}ms exceeded ${LATENCY_ABORT_MS}ms`;
    }
  }, 250);

  const rssBeforeKB = getProcessTreeRssKB(proxyProc.pid);

  function worker() {
    return new Promise((resolve) => {
      function fire() {
        if (aborted || Date.now() >= endAt) {
          resolve();
          return;
        }
        const start = Date.now();
        const req = http.request(
          { host: "127.0.0.1", port: PROXY_PORT, path: "/", method: "GET", agent, headers: { Connection: "keep-alive" } },
          (res) => {
            res.resume();
            res.on("end", () => {
              const ms = Date.now() - start;
              const ok = res.statusCode >= 200 && res.statusCode < 300;
              record(ms, ok);
              // Deferred, not called inline — a keep-alive agent can invoke this completion
              // callback synchronously while handing a freed socket to the next queued
              // request, and calling fire() directly from there can chain into unbounded
              // synchronous recursion ("Maximum call stack size exceeded") at high per-loop
              // connection counts. setImmediate breaks the chain via the event loop.
              setImmediate(fire);
            });
          },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("request timeout")));
        req.on("error", () => {
          record(Date.now() - start, false);
          setImmediate(fire);
        });
        req.end();
      }
      fire();
    });
  }

  function record(ms, ok) {
    const t = Date.now();
    latencies.push(ms);
    if (ok) success2xx++;
    else errorCount++;
    windowSamples.push({ t, ms, ok });
    const secondIdx = Math.floor((t - tierStart) / 1000);
    secondBuckets.set(secondIdx, (secondBuckets.get(secondIdx) ?? 0) + 1);
  }

  const workers = Array.from({ length: tier.connections }, () => worker());
  await Promise.all(workers);

  clearInterval(monitor);
  agent.destroy();

  // Let in-flight TCP teardown / GC settle briefly before the "after" RSS snapshot.
  await sleep(300);
  const rssAfterKB = getProcessTreeRssKB(proxyProc.pid);

  const elapsedMs = Math.min(Date.now(), endAt) - tierStart;
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = success2xx + errorCount;
  const maxRps = secondBuckets.size > 0 ? Math.max(...secondBuckets.values()) : 0;

  return {
    tier,
    aborted,
    abortReason,
    total,
    success2xx,
    errorCount,
    avgRps: elapsedMs > 0 ? total / (elapsedMs / 1000) : 0,
    maxRps,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    rssBeforeKB,
    rssAfterKB,
  };
}

function fmtMB(kb) {
  return `${(kb / 1024).toFixed(1)}MB`;
}

function printSummary(results) {
  console.log("\n================================================================================");
  console.log("  SAFE PRODUCTION CAPACITY BENCHMARK — SUMMARY");
  console.log("================================================================================");
  console.log(`  Proxy workers: ${PROXY_WORKERS} (of ${os.cpus().length} logical cores)`);
  console.log(`  Emergency brake: rolling p95 > ${LATENCY_ABORT_MS}ms OR rolling error rate > ${ERROR_RATE_ABORT * 100}%`);
  console.log("================================================================================\n");

  for (const r of results) {
    console.log(`${r.tier.name}  (${r.tier.connections} connections, ${(r.tier.durationMs / 1000).toFixed(0)}s target)`);
    if (r.aborted) {
      console.log(`  \x1b[31m⛔ EMERGENCY BRAKE TRIPPED: ${r.abortReason}\x1b[0m`);
    }
    console.log(`  Requests:      ${r.total} total  |  ${r.success2xx} 2xx  |  ${r.errorCount} errors/timeouts`);
    const successRate = r.total > 0 ? ((r.success2xx / r.total) * 100).toFixed(2) : "0.00";
    const errorRate = r.total > 0 ? ((r.errorCount / r.total) * 100).toFixed(2) : "0.00";
    console.log(`  Success rate:  ${successRate}%   Error rate: ${errorRate}%`);
    console.log(`  RPS:           avg ${r.avgRps.toFixed(0)}  |  max (1s window) ${r.maxRps}`);
    console.log(
      `  Latency (ms):  p50=${r.p50}  p90=${r.p90}  p95=${r.p95}  p99=${r.p99}  max=${r.max}`,
    );
    console.log(
      `  Proxy RSS:     before ${fmtMB(r.rssBeforeKB)}  →  after ${fmtMB(r.rssAfterKB)}  (Δ ${fmtMB(r.rssAfterKB - r.rssBeforeKB)})`,
    );
    console.log("");
  }

  const tripped = results.find((r) => r.aborted);
  const lastClean = [...results].reverse().find((r) => !r.aborted);
  console.log("--------------------------------------------------------------------------------");
  if (tripped) {
    console.log(`  Breaking point: ${tripped.tier.name} (${tripped.tier.connections} connections) — ${tripped.abortReason}`);
    if (lastClean) {
      const safeLimit = Math.round(lastClean.tier.connections * 0.7);
      console.log(
        `  Last tier within safety thresholds: ${lastClean.tier.name} — avg ${lastClean.avgRps.toFixed(0)} RPS, p99 ${lastClean.p99}ms`,
      );
      console.log(
        `  Recommended safe production limit: ~${safeLimit} concurrent connections (70% of last clean tier, for headroom)`,
      );
    }
  } else {
    const heaviest = results[results.length - 1];
    console.log(`  No breaking point found up to ${heaviest.tier.connections} connections within the tested range.`);
    console.log(
      `  Heaviest tier sustained: avg ${heaviest.avgRps.toFixed(0)} RPS, p99 ${heaviest.p99}ms, ${heaviest.errorCount} errors.`,
    );
    const safeLimit = Math.round(heaviest.tier.connections * 0.7);
    console.log(
      `  Recommended safe production limit: ~${safeLimit} concurrent connections (70% of the heaviest tested tier, for headroom —`,
    );
    console.log(`  true capacity is >= ${heaviest.tier.connections}; re-run with higher tiers to find the actual ceiling).`);
  }
  console.log("--------------------------------------------------------------------------------\n");
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  log("Tearing down (SIGTERM)...");

  async function terminate(child, label) {
    if (!child || child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      sleep(3000).then(() => false),
    ]);
    if (!exited) {
      log(`${label} did not exit after SIGTERM within 3s — sending SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }

  await terminate(proxyProc, "proxy");
  await terminate(mockProc, "mock upstream");

  try {
    fs.unlinkSync(tmpConfigPath);
  } catch {}
}

async function main() {
  log(`Writing temp config to ${tmpConfigPath}`);
  fs.writeFileSync(tmpConfigPath, STRESS_CONFIG_YAML, "utf8");

  log(`Starting mock upstream on port ${MOCK_PORT}...`);
  mockProc = spawn(process.execPath, ["-e", MOCK_SOURCE], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] });
  await waitForStdout(mockProc, "MOCK_READY", 5000, "mock upstream");
  log("Mock upstream ready.");

  log(`Starting reverse proxy (dist/index.js) on port ${PROXY_PORT} with ${PROXY_WORKERS} workers...`);
  const proxyLogPath = path.join(os.tmpdir(), `ninja-stress-proxy-${process.pid}.log`);
  const proxyLogFd = fs.openSync(proxyLogPath, "a");
  proxyProc = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", tmpConfigPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", proxyLogFd, proxyLogFd],
  });
  proxyProc.on("exit", (code, signal) => {
    if (!cleanedUp) {
      log(`\x1b[31mProxy exited unexpectedly (code=${code}, signal=${signal}). See log: ${proxyLogPath}\x1b[0m`);
    }
  });

  await waitForHttp200(PROXY_PORT, 20000, "proxy");
  log(`Proxy is healthy and routing to mock upstream. (log: ${proxyLogPath})`);

  const results = [];
  for (const tier of TIERS) {
    log(`Running ${tier.name}: ${tier.connections} connections for ${(tier.durationMs / 1000).toFixed(0)}s...`);
    const result = await runTier(tier);
    results.push(result);
    if (result.aborted) {
      log(`\x1b[31mEmergency brake tripped during ${tier.name}: ${result.abortReason}. Halting ramp-up.\x1b[0m`);
      break;
    }
    log(`Cooling down for ${(INTER_TIER_COOLDOWN_MS / 1000).toFixed(0)}s before the next tier...`);
    await sleep(INTER_TIER_COOLDOWN_MS);
  }

  printSummary(results);
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  await main();
} catch (err) {
  console.error(`[benchmark] FATAL: ${err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
