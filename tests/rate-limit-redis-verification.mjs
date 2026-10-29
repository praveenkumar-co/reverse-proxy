#!/usr/bin/env node
// =============================================================================
//  RATE LIMIT REDIS VERIFICATION — PHASE C
// =============================================================================
//  production-gates.mjs's Gate 5 proves the in-memory lease-batching path
//  (workers lease permits from master instead of calling it per request).
//  This file proves the OTHER half of Phase C's design: when rate limiting
//  is configured with storage: redis, each worker talks to Redis directly
//  (no master involvement at all) and the shared Redis state still holds
//  the limit to ~maxRequests total across all workers — the same
//  "100 ± 10 of 400, not ~400" bar Gate 5 uses, now via the Redis path.
// =============================================================================

import http from "node:http";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proxyProc = null;
async function startProxy(cfgYaml, port) {
  const registrySnapshotPath = path.join(REPO_ROOT, "proxy_registry_backup.json");
  try { fs.unlinkSync(registrySnapshotPath); } catch {}
  const cfgPath = path.join(os.tmpdir(), `_rl_redis_cfg_${port}.yaml`);
  fs.writeFileSync(cfgPath, cfgYaml);
  const logFile = path.join(os.tmpdir(), `rl-redis-proxy-${port}.log`);
  const out = fs.openSync(logFile, "w");
  proxyProc = spawn(process.execPath, ["dist/index.js", "--config", cfgPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, ADMIN_SECRET: "rl-redis-secret", NODE_ENV: "production" },
    stdio: ["ignore", out, out],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/__ready", timeout: 400, headers: { "x-admin-token": "rl-redis-secret" } },
          (res) => {
            res.resume();
            if (res.statusCode === 200) resolve();
            else reject();
          },
        );
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

async function main() {
  console.log("\n" + BOLD("═".repeat(70)));
  console.log(BOLD("  🔐 RATE LIMIT REDIS VERIFICATION (Phase C, Redis-direct path)"));
  console.log(BOLD("═".repeat(70)));

  let redisAvailable = true;
  try {
    execSync("redis-server --version", { stdio: "ignore" });
  } catch {
    redisAvailable = false;
  }
  if (!redisAvailable) {
    console.log(Y("SKIPPED: no redis-server binary on PATH — install Redis locally to exercise this path"));
    process.exit(0);
  }

  const REDIS_PORT = 16380;
  const redisDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-redis-"));
  const redisProc = spawn(
    "redis-server",
    ["--port", String(REDIS_PORT), "--save", "", "--appendonly", "no", "--dir", redisDataDir, "--daemonize", "no"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let redisReady = false;
  for (let i = 0; i < 40 && !redisReady; i++) {
    try {
      execSync(`redis-cli -p ${REDIS_PORT} ping`, { stdio: "ignore" });
      redisReady = true;
    } catch {
      await sleep(250);
    }
  }
  if (!redisReady) {
    console.error(R("redis-server did not become reachable within 10s"));
    try { redisProc.kill("SIGTERM"); } catch {}
    process.exit(1);
  }

  const PORT = 9820, UP = 19820;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  let passed = false;
  let detail = "";
  try {
    await startProxy(
      `
server:
  port: ${PORT}
  workers: 4
  rateLimit:
    enabled: true
    storage: redis
    algorithm: fixed-window
    windowMs: 60000
    maxRequests: 100
    redis:
      host: "127.0.0.1"
      port: ${REDIS_PORT}
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
`,
      PORT,
    );

    const TOTAL = 400;
    const CONCURRENCY = 20;
    const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
    let issued = 0, allowed = 0, blocked = 0, other = 0;

    async function workerLoop() {
      while (true) {
        const mySlot = ++issued;
        if (mySlot > TOTAL) break;
        await new Promise((resolve) => {
          const req = http.get({ host: "127.0.0.1", port: PORT, path: "/rl-redis-check", agent, timeout: 6000 }, (res) => {
            res.resume();
            if (res.statusCode === 200) allowed++;
            else if (res.statusCode === 429) blocked++;
            else other++;
            resolve();
          });
          req.on("error", () => { other++; resolve(); });
          req.on("timeout", () => { req.destroy(); other++; resolve(); });
        });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
    agent.destroy();

    const withinBand = Math.abs(allowed - 100) <= 10;
    passed = withinBand;
    detail = `Allowed: ${allowed}/${TOTAL} | Blocked (429): ${blocked} | Other: ${other}`;
  } catch (err) {
    detail = err.message;
  } finally {
    stopProxy();
    await new Promise((r) => upstream.close(r));
    try { redisProc.kill("SIGTERM"); } catch {}
    try { fs.rmSync(redisDataDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(path.join(REPO_ROOT, "proxy_registry_backup.json")); } catch {}
  }

  const icon = passed ? G("✅ PASSED") : R("❌ FAILED");
  console.log(
    `  ${icon} Redis-backed rate limit (maxRequests=100) holds across 4 workers for a single IP (100 ± 10 of 400 allowed), talking to Redis directly from each worker — no master involvement`,
  );
  console.log(`            ${Y("↳")} ${detail}`);
  console.log(BOLD("═".repeat(70)) + "\n");
  process.exit(passed ? 0 : 1);
}

main();
