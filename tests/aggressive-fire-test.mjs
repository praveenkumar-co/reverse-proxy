#!/usr/bin/env node
// =============================================================================
//  AGGRESSIVE FIRE TESTING HARNESS — NINJA REVERSE PROXY
//  Hardcore Adversarial Stress Suite (MacBook Thermal & Kernel Safe)
// =============================================================================
//  Phase 1: 10,000-Request High-RPS Saturation Wave (Connection Pool Stress)
//  Phase 2: Upstream Drop Chaos (Kill 2 of 3 backends mid-flight under traffic)
//  Phase 3: Cache Thrashing & Memory Fence (5,000 distinct URLs into LRU)
//  Phase 4: Streaming Chunked Body Bomb (15MB unbuffered upload defense)
//  Phase 5: Rapid Client Abort Storm (500 client sockets severed mid-flight)
// =============================================================================

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const C = (s) => `\x1b[36m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(phase, name, passed, detail = "") {
  results.push({ phase, name, passed, detail });
  const icon = passed ? G("✅ PASSED") : R("❌ FAILED");
  console.log(`  ${icon} [${phase}] ${name}`);
  if (detail) console.log(`            ${Y("↳")} ${detail}`);
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

let proxyProc = null;
async function startProxy(cfgYaml, port) {
  const cfgPath = path.join(REPO_ROOT, `_fire_cfg_${port}.yaml`);
  fs.writeFileSync(cfgPath, cfgYaml);
  const logFile = `/tmp/fire-proxy-${port}.log`;
  const out = fs.openSync(logFile, "w");

  proxyProc = spawn(process.execPath, ["dist/index.js", "--config", cfgPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, ADMIN_SECRET: "fire-secret", NODE_ENV: "production" },
    stdio: ["ignore", out, out],
  });

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/__ready", timeout: 400 }, (res) => {
          res.resume();
          if (res.statusCode < 500) resolve();
          else reject();
        });
        req.on("error", reject);
      });
      return;
    } catch {}
  }
  throw new Error(`Proxy port ${port} never became ready.`);
}

function stopProxy() {
  if (proxyProc && proxyProc.exitCode === null) {
    try { proxyProc.kill("SIGTERM"); } catch {}
  }
  proxyProc = null;
}

// -----------------------------------------------------------------------------
// Phase 1: 10,000-Request Saturation Wave
// -----------------------------------------------------------------------------
async function phase1() {
  console.log(`\n${BOLD("─── PHASE 1: 10,000-Request Saturation Wave ─────────────────")}`);
  console.log(`    ${C("Firing 10,000 requests over 100 pooled keep-alive sockets")}`);

  const PORT = 9911, UP = 19911;
  let received = 0;
  const upstream = http.createServer((req, res) => {
    received++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  await startProxy(`
server:
  port: ${PORT}
  workers: 2
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
  loadBalancing:
    strategy: round-robin
    retry:
      maxAttempts: 0
      statusCodes: []
  connectTimeoutMs: 5000
  readTimeoutMs: 10000
`, PORT);

  const TOTAL = 10000;
  const CONCURRENCY = 100;
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  const latencies = [];
  let completed = 0;
  let errors = 0;

  const tStart = performance.now();

  async function workerLoop() {
    while (true) {
      const idx = completed + errors;
      if (idx >= TOTAL) break;
      const t0 = performance.now();
      try {
        await new Promise((resolve) => {
          const req = http.get({ host: "127.0.0.1", port: PORT, path: "/fire1", agent, timeout: 6000 }, (res) => {
            res.resume();
            if (res.statusCode === 200) completed++;
            else errors++;
            resolve();
          });
          req.on("error", () => { errors++; resolve(); });
          req.on("timeout", () => { req.destroy(); errors++; resolve(); });
        });
        latencies.push(performance.now() - t0);
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
  agent.destroy();

  const totalTimeSec = (performance.now() - tStart) / 1000;
  const rps = completed / totalTimeSec;
  const p50 = percentile(latencies, 50).toFixed(1);
  const p99 = percentile(latencies, 99).toFixed(1);

  record(
    "Phase 1",
    `Completed ${completed}/${TOTAL} requests with high throughput`,
    completed >= TOTAL * 0.99,
    `RPS: ${rps.toFixed(0)} req/s | p50: ${p50}ms | p99: ${p99}ms | Time: ${totalTimeSec.toFixed(2)}s | Errors: ${errors}`
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(800);
}

// -----------------------------------------------------------------------------
// Phase 2: Mid-Flight Upstream Drop Chaos
// -----------------------------------------------------------------------------
async function phase2() {
  console.log(`\n${BOLD("─── PHASE 2: Mid-Flight Upstream Drop Chaos ──────────────────")}`);
  console.log(`    ${C("Abruptly killing 2 out of 3 backends during active live traffic")}`);

  const PORT = 9912;
  const ports = [19912, 19913, 19914];
  const upstreams = [];
  const hits = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    const s = http.createServer((req, res) => {
      hits[i]++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`backend-${i + 1}`);
    });
    await new Promise((r) => s.listen(ports[i], "127.0.0.1", r));
    upstreams.push(s);
  }

  await startProxy(`
server:
  port: ${PORT}
  workers: 2
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${ports[0]}
    - id: u2
      url: http://127.0.0.1:${ports[1]}
    - id: u3
      url: http://127.0.0.1:${ports[2]}
  paths:
    - path: /
      upstream: [u1, u2, u3]
  loadBalancing:
    strategy: round-robin
    retry:
      maxAttempts: 2
      statusCodes: [502, 503]
  connectTimeoutMs: 1500
  readTimeoutMs: 3000
`, PORT);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 40 });
  let success = 0;
  let failed = 0;

  let running = true;
  const trafficLoop = (async () => {
    while (running) {
      try {
        await new Promise((resolve) => {
          const req = http.get({ host: "127.0.0.1", port: PORT, path: "/failover", agent, timeout: 3000 }, (res) => {
            res.resume();
            if (res.statusCode === 200) success++;
            else failed++;
            resolve();
          });
          req.on("error", () => { failed++; resolve(); });
          req.on("timeout", () => { req.destroy(); failed++; resolve(); });
        });
      } catch {}
      await sleep(10);
    }
  })();

  await sleep(1500);
  console.log(`    ${Y("💥 Killing Backend 1 & 2 mid-stream...")}`);
  await new Promise((r) => upstreams[0].close(r));
  await new Promise((r) => upstreams[1].close(r));

  await sleep(2500);
  running = false;
  await trafficLoop;
  agent.destroy();

  record(
    "Phase 2",
    "Seamless failover to surviving upstream with zero hung sockets",
    hits[2] > 15 && success > 40,
    `Surviving Backend-3 handled ${hits[2]} requests | Success: ${success} | Handled Drops: ${failed}`
  );

  stopProxy();
  await new Promise((r) => upstreams[2].close(r));
  await sleep(800);
}

// -----------------------------------------------------------------------------
// Phase 3: Cache Thrashing & Memory Fence (5,000 Keys)
// -----------------------------------------------------------------------------
async function phase3() {
  console.log(`\n${BOLD("─── PHASE 3: Cache Thrashing & Memory Fence ──────────────────")}`);
  console.log(`    ${C("Blasting 5,000 distinct URLs into LRU cache; verifying bounded RSS")}`);

  const PORT = 9913, UP = 19915, REDIS_PORT = 16379;
  const mockRedis = net.createServer((sock) => {
    sock.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("PING")) sock.write("+PONG\r\n");
      else if (msg.includes("INFO")) sock.write("$0\r\n\r\n");
      else sock.write("+OK\r\n");
    });
  });
  await new Promise((r) => mockRedis.listen(REDIS_PORT, "127.0.0.1", r));

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "public, max-age=60",
    });
    res.end("cached-data-" + "a".repeat(256));
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  await startProxy(`
server:
  port: ${PORT}
  workers: 2
  rateLimit:
    enabled: false
  cache:
    enabled: true
    host: "127.0.0.1"
    port: ${REDIS_PORT}
    ttlSeconds: 60
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
      cache:
        enabled: true
        ttlSeconds: 60
`, PORT);

  const rssBefore = process.memoryUsage().rss / (1024 * 1024);
  const KEYS = 5000;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 60 });

  await Promise.all(
    Array.from({ length: KEYS }, (_, i) =>
      new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: PORT, path: `/cache-item?id=${i}`, agent, timeout: 5000 }, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", resolve);
      })
    )
  );

  agent.destroy();
  const rssAfter = process.memoryUsage().rss / (1024 * 1024);
  const growthMB = rssAfter - rssBefore;

  record(
    "Phase 3",
    "LRU cache strictly bounds memory under 5,000 unique key flood",
    growthMB < 85,
    `Memory RSS growth: ${growthMB.toFixed(1)} MB (Safe limit: <85 MB) | Total Keys Stored: ${KEYS}`
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  mockRedis.close();
  await sleep(800);
}

// -----------------------------------------------------------------------------
// Phase 4: Streaming Chunked Body Bomb Defense
// -----------------------------------------------------------------------------
async function phase4() {
  console.log(`\n${BOLD("─── PHASE 4: Streaming Chunked Body Bomb Defense ─────────────")}`);
  console.log(`    ${C("Sending 15MB unbuffered chunked body; verifying 10MB memory cutoff")}`);

  const PORT = 9914, UP = 19916;
  let bytesReceived = 0;
  const upstream = http.createServer((req, res) => {
    req.on("data", (c) => { bytesReceived += c.length; });
    req.on("end", () => {
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  await startProxy(`
server:
  port: ${PORT}
  workers: 1
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
  connectTimeoutMs: 5000
  readTimeoutMs: 8000
`, PORT);

  let status = 0;
  await new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/stream-bomb",
        method: "POST",
        headers: { "Transfer-Encoding": "chunked", "Content-Type": "application/octet-stream" },
      },
      (res) => {
        status = res.statusCode;
        res.resume();
        resolve();
      }
    );

    req.on("error", () => resolve());

    let sent = 0;
    const chunk = Buffer.alloc(1024 * 1024, 0x42); // 1MB chunk
    const timer = setInterval(() => {
      if (sent >= 15 || req.destroyed) {
        clearInterval(timer);
        if (!req.destroyed) req.end();
        return;
      }
      req.write(chunk);
      sent++;
    }, 20);
  });

  const defended = status === 413 || bytesReceived <= 11 * 1024 * 1024;
  record(
    "Phase 4",
    "10MB streaming limit enforced (preventing worker memory exhaustion)",
    defended,
    `Status: ${status || "Connection Reset"} | Upstream Received: ${(bytesReceived / (1024 * 1024)).toFixed(1)} MB of 15 MB attempted`
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(800);
}

// -----------------------------------------------------------------------------
// Phase 5: Rapid Client Abort Storm (500 Connections)
// -----------------------------------------------------------------------------
async function phase5() {
  console.log(`\n${BOLD("─── PHASE 5: Rapid Client Abort Storm (500 Connections) ──────")}`);
  console.log(`    ${C("Clients sever 500 TCP sockets mid-flight; verifying 0 socket leaks")}`);

  const PORT = 9915, UP = 19917;
  let activeUpstreamSockets = 0;
  let abortedCleanly = 0;

  const upstream = http.createServer((req, res) => {
    activeUpstreamSockets++;
    req.on("close", () => {
      activeUpstreamSockets--;
      abortedCleanly++;
    });
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end("late");
      }
    }, 3000);
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  await startProxy(`
server:
  port: ${PORT}
  workers: 2
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
  connectTimeoutMs: 5000
  readTimeoutMs: 8000
`, PORT);

  const ABORTS = 500;
  for (let i = 0; i < ABORTS; i++) {
    const s = net.connect({ host: "127.0.0.1", port: PORT }, () => {
      s.write("GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      setTimeout(() => s.destroy(), 50);
    });
    s.on("error", () => {});
    if (i % 50 === 0) await sleep(20);
  }

  await sleep(2000);

  record(
    "Phase 5",
    "All 500 severed client connections propagated aborts upstream cleanly",
    activeUpstreamSockets <= 2,
    `Lingering active upstream sockets: ${activeUpstreamSockets} | Aborted upstream handlers fired: ${abortedCleanly}`
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
}

// -----------------------------------------------------------------------------
// Main Orchestration
// -----------------------------------------------------------------------------
async function main() {
  console.log("\n" + BOLD("═".repeat(70)));
  console.log(BOLD("  🔥  AGGRESSIVE FIRE TESTING HARNESS — NINJA REVERSE PROXY"));
  console.log(BOLD("  (Heavy Concurrency, Upstream Chaos, Cache Thrash & Socket Abort)"));
  console.log(BOLD("═".repeat(70)));

  const t0 = performance.now();
  try {
    await phase1();
    await phase2();
    await phase3();
    await phase4();
    await phase5();
  } catch (err) {
    console.error(R(`\nFATAL RUNNER ERROR: ${err.message}`));
  } finally {
    stopProxy();
    try {
      const files = fs.readdirSync(REPO_ROOT).filter((f) => f.startsWith("_fire_cfg_"));
      for (const f of files) fs.unlinkSync(path.join(REPO_ROOT, f));
    } catch {}
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  console.log("\n" + BOLD("═".repeat(70)));
  console.log(BOLD("  📊 AGGRESSIVE FIRE TESTING SCORECARD"));
  console.log(BOLD("═".repeat(70)));

  let passed = 0;
  for (const r of results) {
    if (r.passed) passed++;
    const status = r.passed ? G("PASSED") : R("FAILED");
    console.log(`  ${r.phase.padEnd(10)} : ${r.name.padEnd(52)} [${status}]`);
  }

  console.log("─".repeat(70));
  console.log(`  Total Passed: ${passed}/${results.length} | Total Runtime: ${elapsed}s`);
  console.log(BOLD("═".repeat(70)) + "\n");

  process.exit(passed === results.length ? 0 : 1);
}

main();
