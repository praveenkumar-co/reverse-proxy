// =============================================================================
// ULTIMATE BEAST BENCHMARK — unconstrained single-run saturation test
// =============================================================================
// 650 persistent keep-alive connections, 20s, 80/20 GET/POST mix, against the
// proxy running with all 10 workers, ERROR-only logging, and an 8192→65535
// listen backlog request. The load generator itself runs across multiple
// worker_threads so it isn't the bottleneck being measured.
//
// Honest caveats baked into this run, not glossed over in the report:
//   - This machine's kernel backlog ceiling (kern.ipc.somaxconn) is 128. Node's
//     listen() backlog argument is clamped by the OS to that value no matter
//     what we pass — raising it to 65535 only matters on a kernel configured
//     to allow it. We did not run `sysctl -w kern.ipc.somaxconn=...` because
//     that is a persistent, machine-wide change outside this process, not
//     something to flip unilaterally for a benchmark.
//   - Proxy workers (10) + generator threads together can exceed this
//     machine's 10 logical cores. That's the literal "all cores" ask; it
//     means some oversubscription/contention is expected and is noted in the
//     final report rather than hidden.
//
// Uses a dedicated benchmark config (not the repo's tracked config.yaml) for
// the same reason as the prior two benchmark scripts: it keeps the real
// project config untouched while still exercising the exact settings asked
// for (10 workers, ERROR logging, 65535 backlog).
// =============================================================================

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------
const MOCK_PORT = 3102;
const PROXY_PORT = 8199;
const LISTEN_BACKLOG = 65535;
const PROXY_WORKERS = 10;
const LOG_LEVEL = "error";
const CONNECTIONS = 650;
const DURATION_MS = 20_000;
const REQUEST_TIMEOUT_MS = 2000;
const GENERATOR_THREADS = 4;
const POST_RATIO = 0.2; // 20% POST, 80% GET
const START_SYNC_BUFFER_MS = 500; // lets all generator threads spin up before the clock starts

function buildPostBody(targetBytes) {
  const base = { event: "benchmark.post", payload: "", ts: Date.now() };
  const baseLen = Buffer.byteLength(JSON.stringify(base));
  base.payload = "x".repeat(Math.max(0, targetBytes - baseLen));
  return JSON.stringify(base);
}
const POST_BODY = buildPostBody(1024);

// =============================================================================
// GENERATOR THREAD (runs when this file is loaded as a worker_thread)
// =============================================================================
if (!isMainThread) {
  const { threadIndex, connections, proxyPort, durationMs, requestTimeoutMs, postRatio, postBody, startAt } =
    workerData;

  function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
    return sortedArr[idx];
  }

  async function run() {
    const postBodyBuffer = Buffer.from(postBody, "utf8");
    const agent = new http.Agent({ keepAlive: true, maxSockets: connections, maxFreeSockets: connections });

    const latencies = [];
    let success2xx = 0;
    let errorCount = 0;
    const secondBuckets = new Map();

    const waitMs = startAt - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const endAt = startAt + durationMs;

    function record(ms, ok) {
      const t = Date.now();
      latencies.push(ms);
      if (ok) success2xx++;
      else errorCount++;
      const secondIdx = Math.floor((t - startAt) / 1000);
      secondBuckets.set(secondIdx, (secondBuckets.get(secondIdx) ?? 0) + 1);
    }

    function worker() {
      return new Promise((resolve) => {
        function fire() {
          if (Date.now() >= endAt) {
            resolve();
            return;
          }
          const isPost = Math.random() < postRatio;
          const start = Date.now();
          const options = {
            host: "127.0.0.1",
            port: proxyPort,
            path: "/",
            method: isPost ? "POST" : "GET",
            agent,
            headers: isPost
              ? {
                  Connection: "keep-alive",
                  "Content-Type": "application/json",
                  "Content-Length": postBodyBuffer.length,
                }
              : { Connection: "keep-alive" },
          };
          const req = http.request(options, (res) => {
            res.resume();
            res.on("end", () => {
              const ms = Date.now() - start;
              record(ms, res.statusCode >= 200 && res.statusCode < 300);
              // Deferred rather than called inline: with keep-alive agents, a completion
              // callback can fire synchronously as part of the agent handing a freed socket
              // to the next queued request, and calling fire() directly from in there chains
              // into unbounded synchronous recursion (observed: "Maximum call stack size
              // exceeded" once per-thread connection counts got large enough). setImmediate
              // breaks that chain by always returning to the event loop first.
              setImmediate(fire);
            });
          });
          req.setTimeout(requestTimeoutMs, () => req.destroy(new Error("request timeout")));
          req.on("error", () => {
            record(Date.now() - start, false);
            setImmediate(fire);
          });
          if (isPost) req.end(postBodyBuffer);
          else req.end();
        }
        fire();
      });
    }

    const workers = Array.from({ length: connections }, () => worker());
    await Promise.all(workers);
    agent.destroy();

    const sorted = [...latencies].sort((a, b) => a - b);
    parentPort.postMessage({
      threadIndex,
      total: success2xx + errorCount,
      success2xx,
      errorCount,
      latencies: sorted,
      secondBuckets: Array.from(secondBuckets.entries()),
    });
  }

  run().catch((err) => {
    console.error(`GENERATOR_THREAD_ERROR[${threadIndex}]`, err);
    process.exit(1);
  });
} else {
  // ===========================================================================
  // MAIN THREAD — orchestration
  // ===========================================================================
  const tmpConfigPath = path.join(os.tmpdir(), `ninja-beast-config-${process.pid}.yaml`);
  let mockProc;
  let proxyProc;
  let cleanedUp = false;

  const MOCK_SOURCE = `
const http = require('http');
const port = ${MOCK_PORT};
const okBody = Buffer.from(JSON.stringify({ status: 'ok' }));
const server = http.createServer((req, res) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': okBody.length });
      res.end(okBody);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': okBody.length });
    res.end(okBody);
  }
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

  const BEAST_CONFIG_YAML = `
server:
  listen: ${PROXY_PORT}
  workers: ${PROXY_WORKERS}
  trustProxy: true
  trustedProxies: ["127.0.0.1", "::1"]
  compression: false
  backlog: ${LISTEN_BACKLOG}

tls:
  enabled: false

observability:
  logging:
    level: ${LOG_LEVEL}
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
    console.log(`[beast] ${msg}`);
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
      return [];
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

  function runGeneratorThread(threadIndex, connections, startAt) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: {
          threadIndex,
          connections,
          proxyPort: PROXY_PORT,
          durationMs: DURATION_MS,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          postRatio: POST_RATIO,
          postBody: POST_BODY,
          startAt,
        },
      });
      worker.once("message", (stats) => {
        worker.terminate().then(() => resolve(stats));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`generator thread ${threadIndex} exited with code ${code}`));
      });
    });
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

  function printReport({ total, success2xx, errorCount, latencies, peakRps, avgRps, elapsedSec, rssBeforeKB, rssAfterKB }) {
    const fmtMB = (kb) => `${(kb / 1024).toFixed(1)}MB`;
    const successRate = total > 0 ? ((success2xx / total) * 100).toFixed(2) : "0.00";
    const errorRate = total > 0 ? ((errorCount / total) * 100).toFixed(2) : "0.00";

    console.log("\n================================================================================");
    console.log("  ULTIMATE BEAST BENCHMARK — RESULTS");
    console.log("================================================================================");
    console.log(`  Proxy workers: ${PROXY_WORKERS} (all logical cores on this ${os.cpus().length}-core machine)`);
    console.log(`  Generator: ${GENERATOR_THREADS} worker_threads, ${CONNECTIONS} total persistent connections`);
    console.log(`  Load mix: ${(1 - POST_RATIO) * 100}% GET, ${POST_RATIO * 100}% POST (~1KB JSON body)`);
    console.log(`  Requested: backlog=${LISTEN_BACKLOG}, log level=${LOG_LEVEL}`);
    console.log(
      `  Kernel reality check: this Mac's kern.ipc.somaxconn is 128 — the OS clamps the effective accept`,
    );
    console.log(`  backlog to that regardless of the ${LISTEN_BACKLOG} requested (not altered; that's a system-wide sysctl).`);
    console.log("================================================================================\n");

    console.log(`  Duration:            ${elapsedSec.toFixed(1)}s (target ${(DURATION_MS / 1000).toFixed(0)}s)`);
    console.log(`  Total requests:       ${total}`);
    console.log(`  Success (2xx):        ${success2xx}  (${successRate}%)`);
    console.log(`  Errors/timeouts:      ${errorCount}  (${errorRate}%)`);
    console.log(`  Absolute Peak RPS:    ${peakRps}  (best single 1-second window)`);
    console.log(`  Average Sustained RPS: ${avgRps.toFixed(0)}`);
    console.log(
      `  Latency (ms):         p50=${percentile(latencies, 50)}  p90=${percentile(latencies, 90)}  p95=${percentile(latencies, 95)}  p99=${percentile(latencies, 99)}  max=${latencies.length ? latencies[latencies.length - 1] : 0}`,
    );
    console.log(
      `  Proxy RSS:            before ${fmtMB(rssBeforeKB)}  →  after ${fmtMB(rssAfterKB)}  (Δ ${fmtMB(rssAfterKB - rssBeforeKB)})`,
    );
    console.log("\n--------------------------------------------------------------------------------");
    const targetsHit = total >= 250_000 && peakRps >= 15_000;
    console.log(
      targetsHit
        ? "  Target met: >=250,000 total requests AND >=15,000 peak RPS."
        : `  Target NOT fully met (>=250,000 total requests and >=15,000 peak RPS) — reporting actual measured numbers above, not adjusted.`,
    );
    console.log("--------------------------------------------------------------------------------\n");
  }

  async function main() {
    log(`Writing beast config to ${tmpConfigPath}`);
    fs.writeFileSync(tmpConfigPath, BEAST_CONFIG_YAML, "utf8");

    log(`Starting mock upstream on port ${MOCK_PORT}...`);
    mockProc = spawn(process.execPath, ["-e", MOCK_SOURCE], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] });
    await waitForStdout(mockProc, "MOCK_READY", 5000, "mock upstream");
    log("Mock upstream ready.");

    log(`Starting reverse proxy with ${PROXY_WORKERS} workers, log level=${LOG_LEVEL}, backlog=${LISTEN_BACKLOG}...`);
    const proxyLogPath = path.join(os.tmpdir(), `ninja-beast-proxy-${process.pid}.log`);
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
    log(`Proxy healthy with ${PROXY_WORKERS} workers. (log: ${proxyLogPath})`);

    const rssBeforeKB = getProcessTreeRssKB(proxyProc.pid);

    // Distribute connections evenly across generator threads.
    const perThread = Array.from({ length: GENERATOR_THREADS }, (_, i) => {
      const base = Math.floor(CONNECTIONS / GENERATOR_THREADS);
      const remainder = CONNECTIONS % GENERATOR_THREADS;
      return base + (i < remainder ? 1 : 0);
    });

    const startAt = Date.now() + START_SYNC_BUFFER_MS;
    log(
      `Launching ${GENERATOR_THREADS} generator threads (${perThread.join("/")} connections) for ${(DURATION_MS / 1000).toFixed(0)}s, starting in ${START_SYNC_BUFFER_MS}ms...`,
    );

    const threadResults = await Promise.all(
      perThread.map((conns, i) => runGeneratorThread(i, conns, startAt)),
    );

    await sleep(300);
    const rssAfterKB = getProcessTreeRssKB(proxyProc.pid);

    let total = 0;
    let success2xx = 0;
    let errorCount = 0;
    const mergedLatencies = [];
    const globalSecondBuckets = new Map();
    for (const r of threadResults) {
      total += r.total;
      success2xx += r.success2xx;
      errorCount += r.errorCount;
      mergedLatencies.push(...r.latencies);
      for (const [secondIdx, count] of r.secondBuckets) {
        globalSecondBuckets.set(secondIdx, (globalSecondBuckets.get(secondIdx) ?? 0) + count);
      }
    }
    mergedLatencies.sort((a, b) => a - b);
    const peakRps = globalSecondBuckets.size > 0 ? Math.max(...globalSecondBuckets.values()) : 0;
    const elapsedSec = DURATION_MS / 1000;
    const avgRps = total / elapsedSec;

    printReport({
      total,
      success2xx,
      errorCount,
      latencies: mergedLatencies,
      peakRps,
      avgRps,
      elapsedSec,
      rssBeforeKB,
      rssAfterKB,
    });
  }

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });

  try {
    await main();
  } catch (err) {
    console.error(`[beast] FATAL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
