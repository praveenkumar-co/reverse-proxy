#!/usr/bin/env node
// =============================================================================
//  PRODUCTION GATE SUITE — NINJA REVERSE PROXY
// =============================================================================
//  Five hard gates a build must clear before it is allowed to call itself
//  production-ready. Each gate starts its own instance of the proxy from
//  dist/ against local mock upstreams, drives it, and asserts a single
//  pass/fail condition. The suite exits 1 if any gate fails.
//
//  Gate 1: Slow client               — proxy RSS growth bounded while a
//                                       client trickles a 200MB response.
//  Gate 2: Large upload              — a 100MB streamed POST reaches the
//                                       upstream byte-for-byte, RSS bounded.
//  Gate 3: Master off the datapath   — master's CPU share stays small across
//                                       5,000 requests.
//  Gate 4: CPU efficiency            — total proxy CPU time per 1,000
//                                       requests (20,000-request measurement)
//                                       is at or under 1.0x a baseline keyed
//                                       to THIS machine (hostname+platform)
//                                       in tests/perf-baseline.json's
//                                       cpuBaselines map. Deliberately not
//                                       RPS-based — see the comment on
//                                       gate4_cpuEfficiency() for why.
//  Gate 5: Rate limit across workers — a per-IP limit holds even though the
//                                       proxy runs 4 worker processes.
//
//  Run `node tests/production-gates.mjs --record-baseline` once per machine
//  this suite runs on (including inside a fresh Docker container) to record
//  that machine's Gate 4 baseline — it automates building a git worktree of
//  the pre-Phase-B commit and measuring it the same way Gate 4 measures the
//  current build, then saves the result under this machine's key. Gate 4
//  fails clearly, rather than comparing against the wrong machine, if this
//  machine has no recorded baseline yet.
// =============================================================================

import http from "node:http";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_FILE = path.join(__dirname, "perf-baseline.json");

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const C = (s) => `\x1b[36m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? G("✅ PASSED") : R("❌ FAILED");
  console.log(`  ${icon} ${name}`);
  if (detail) console.log(`            ${Y("↳")} ${detail}`);
}

// -----------------------------------------------------------------------------
// Process-tree helpers (RSS + cumulative CPU time), same technique as
// aggressive-fire-test.mjs: measure the proxy's real process tree, not this
// harness's own memory/CPU, since master+workers is what we're gating.
//
// Two implementations: macOS (and any other non-Linux platform) shells out to
// `ps`, same as before. Linux reads /proc/<pid>/{stat,status} directly —
// not just a style preference: the node:22 Docker image this is verified
// against doesn't ship procps (no `ps`, no `pgrep`), so a `ps`-based
// implementation would silently return 0 there (swallowed by a try/catch)
// and every gate using it would spuriously pass with "0 bytes of growth" or
// "0 CPU seconds used" instead of actually measuring anything.
// -----------------------------------------------------------------------------
const IS_LINUX = os.platform() === "linux";

let _clkTck;
function getClkTck() {
  if (_clkTck !== undefined) return _clkTck;
  try {
    _clkTck = parseInt(execSync("getconf CLK_TCK", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), 10) || 100;
  } catch {
    _clkTck = 100; // standard default on virtually every Linux system
  }
  return _clkTck;
}

// /proc/<pid>/stat's 2nd field (comm) is parenthesized and may itself contain
// spaces or parens, so field-splitting must start after the LAST ")" on the
// line, not blindly split(" ")[1]. Fields after that point, 0-indexed:
// 0=state 1=ppid 2=pgrp 3=session 4=tty_nr 5=tpgid 6=flags 7=minflt 8=cminflt
// 9=majflt 10=cmajflt 11=utime 12=stime ...
function readProcStatFields(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const closeParen = raw.lastIndexOf(")");
  return raw.slice(closeParen + 2).trim().split(/\s+/);
}

function getChildPidsLinux(parentPid) {
  const children = [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return children;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = readProcStatFields(entry);
      if (Number(fields[1]) === parentPid) children.push(Number(entry));
    } catch {}
  }
  return children;
}

function getChildPids(pid) {
  if (IS_LINUX) return getChildPidsLinux(pid);
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
  if (IS_LINUX) {
    let total = 0;
    for (const pid of pids) {
      try {
        const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (m) total += parseInt(m[1], 10);
      } catch {}
    }
    return total;
  }
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

// Parses `ps -o time=` output ("MM:SS.ss", "HH:MM:SS[.ss]", or "DD-HH:MM:SS")
// into fractional seconds of cumulative CPU time for one process (macOS path).
function parseCpuTimeToSeconds(raw) {
  const s = raw.trim();
  if (!s) return 0;
  let days = 0;
  let rest = s;
  if (s.includes("-")) {
    const [d, r] = s.split("-");
    days = parseInt(d, 10) || 0;
    rest = r ?? "0:00";
  }
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else seconds = parts[0] || 0;
  return days * 86400 + seconds;
}

function getCpuSecondsByPidLinux(pids) {
  const map = new Map();
  const clkTck = getClkTck();
  for (const pid of pids) {
    try {
      const fields = readProcStatFields(pid);
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      map.set(pid, (utime + stime) / clkTck);
    } catch {}
  }
  return map;
}

function getCpuSecondsByPid(pids) {
  const map = new Map();
  if (pids.length === 0) return map;
  if (IS_LINUX) return getCpuSecondsByPidLinux(pids);
  try {
    const out = execSync(`ps -o pid=,time= -p ${pids.join(",")}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(" ");
      if (sep === -1) continue;
      const pid = parseInt(trimmed.slice(0, sep), 10);
      const timeStr = trimmed.slice(sep + 1).trim();
      if (!Number.isNaN(pid)) map.set(pid, parseCpuTimeToSeconds(timeStr));
    }
  } catch {}
  return map;
}

// Machine identity Gate 4's CPU baseline is keyed on — hostname + platform,
// so a baseline recorded on one machine (or one fixed-hostname Docker image)
// is never silently compared against a different machine's measurement.
function machineKey() {
  return `${os.hostname()}:${os.platform()}`;
}

// -----------------------------------------------------------------------------
// Proxy process lifecycle — mirrors aggressive-fire-test.mjs's startProxy:
// same registry-snapshot race avoidance (delete before every start), same
// tmpdir-only config/log files, same /__ready + x-admin-token readiness poll.
// -----------------------------------------------------------------------------
let proxyProc = null;
async function startProxy(cfgYaml, port, { readyTimeoutMs = 15000, repoRoot = REPO_ROOT } = {}) {
  const registrySnapshotPath = path.join(repoRoot, "proxy_registry_backup.json");
  try { fs.unlinkSync(registrySnapshotPath); } catch {}
  const cfgPath = path.join(os.tmpdir(), `_gate_cfg_${port}.yaml`);
  fs.writeFileSync(cfgPath, cfgYaml);
  const logFile = path.join(os.tmpdir(), `gate-proxy-${port}.log`);
  const out = fs.openSync(logFile, "w");

  proxyProc = spawn(process.execPath, ["dist/index.js", "--config", cfgPath], {
    cwd: repoRoot,
    env: { ...process.env, ADMIN_SECRET: "gate-secret", NODE_ENV: "production" },
    stdio: ["ignore", out, out],
  });

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/__ready", timeout: 400, headers: { "x-admin-token": "gate-secret" } },
          (res) => {
            res.resume();
            if (res.statusCode === 200) resolve();
            else reject();
          },
        );
        req.on("error", reject);
      });
      return proxyProc.pid;
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
// Load-generation helpers shared by Gate 3 and Gate 4.
// -----------------------------------------------------------------------------
async function fireFixedCount(port, totalRequests, concurrency, pathName) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  let issued = 0, completed = 0, errors = 0;
  const tStart = performance.now();
  async function workerLoop() {
    while (true) {
      const mySlot = ++issued;
      if (mySlot > totalRequests) break;
      await new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: pathName, agent, timeout: 6000 }, (res) => {
          res.resume();
          if (res.statusCode === 200) completed++; else errors++;
          resolve();
        });
        req.on("error", () => { errors++; resolve(); });
        req.on("timeout", () => { req.destroy(); errors++; resolve(); });
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  agent.destroy();
  const elapsedSec = (performance.now() - tStart) / 1000;
  return { completed, errors, elapsedSec, rps: completed / elapsedSec };
}

// -----------------------------------------------------------------------------
// Gate 1: Slow client — proxy must not balloon in memory just because a
// client is draining a large response slowly. Upstream streams a real 200MB
// body (backpressure-respecting via res.write()'s return value); the client
// throttles its own consumption to ~1MB/s for a 10s window via pause/resume.
// -----------------------------------------------------------------------------
async function gate1_slowClientMemory() {
  console.log(`\n${BOLD("─── GATE 1: Slow-Client Memory Bound (200MB @ 1MB/s, 10s) ────")}`);
  const PORT = 9801, UP = 19801;
  const TOTAL_BYTES = 200 * 1024 * 1024;

  const upstream = http.createServer((req, res) => {
    // The warmup request (below) must NOT trigger a 200MB transfer of its own — it hits this
    // same mock, so without this early-out the "baseline" RSS snapshot would be taken while an
    // entirely separate, unthrottled 200MB download from the warmup is still draining in the
    // background, inflating both the baseline and the peak with unrelated traffic.
    if (req.url !== "/slow-download") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(TOTAL_BYTES) });
    const chunk = Buffer.alloc(64 * 1024, 0x58);
    let written = 0;
    function writeMore() {
      while (written < TOTAL_BYTES) {
        const remaining = TOTAL_BYTES - written;
        const buf = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        written += buf.length;
        if (!res.write(buf)) {
          res.once("drain", writeMore);
          return;
        }
      }
      res.end();
    }
    writeMore();
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  let pid;
  try {
    pid = await startProxy(`
server:
  port: ${PORT}
  workers: 2
  maxResponseBytes: 314572800
  readTimeoutMs: 60000
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
`, PORT);
  } catch (err) {
    record("Slow client: proxy RSS growth stays under 100MB while trickling a 200MB response", false, err.message);
    await new Promise((r) => upstream.close(r));
    return;
  }

  await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/warmup", timeout: 5000 }, (res) => { res.resume(); resolve(); });
    req.on("error", () => resolve());
  });
  await sleep(300);

  const baselineRssMB = getProcessTreeRssKB(pid) / 1024;
  let peakRssMB = baselineRssMB;
  let received = 0;
  const RATE_BYTES_PER_SEC = 1 * 1024 * 1024;
  const WINDOW_MS = 10000;

  await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/slow-download", timeout: WINDOW_MS + 15000 }, (res) => {
      const start = performance.now();
      res.pause();
      const sampler = setInterval(() => {
        const rss = getProcessTreeRssKB(pid) / 1024;
        if (rss > peakRssMB) peakRssMB = rss;
      }, 500);
      const admit = () => {
        const elapsedSec = (performance.now() - start) / 1000;
        const allowed = RATE_BYTES_PER_SEC * elapsedSec;
        if (received < allowed) res.resume();
        else res.pause();
      };
      const ticker = setInterval(admit, 50);
      res.on("data", (chunk) => {
        received += chunk.length;
        admit();
      });
      const finish = () => {
        clearInterval(ticker);
        clearInterval(sampler);
        req.destroy();
        resolve();
      };
      setTimeout(finish, WINDOW_MS);
      res.on("end", finish);
      res.on("error", finish);
    });
    req.on("error", () => resolve());
  });

  const growthMB = peakRssMB - baselineRssMB;
  record(
    "Slow client: proxy RSS growth stays under 100MB while trickling a 200MB response at 1MB/s for 10s",
    growthMB < 100,
    `Baseline: ${baselineRssMB.toFixed(1)}MB | Peak: ${peakRssMB.toFixed(1)}MB | Growth: ${growthMB.toFixed(1)}MB | Client received: ${(received / 1024 / 1024).toFixed(1)}MB of 200MB`
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(500);
}

// -----------------------------------------------------------------------------
// Gate 2: Large streamed upload — a 100MB chunked POST (no Content-Length,
// so it exercises the streaming byte-accounting path rather than the
// Content-Length pre-check) must reach the upstream with a matching
// SHA-256, without the proxy's RSS growing by 100MB+ in the process.
//
// The route below carries a `maxBodyBytes: 209715200` override attempting
// to raise the per-route body limit to 200MB. There is currently no such
// config knob in src/config/schemas — request bodies are capped by a
// hardcoded 10MB constant in src/core/cluster/master.ts regardless of what
// the route config says, so this field is silently ignored by the zod
// schema today. It is left in the test config as the gate's stated contract
// for when that knob is added.
// -----------------------------------------------------------------------------
async function gate2_largeUpload() {
  console.log(`\n${BOLD("─── GATE 2: Large Streamed Upload (100MB, SHA-256 integrity) ─")}`);
  const PORT = 9802, UP = 19802;
  const SIZE = 100 * 1024 * 1024;

  let upstreamBytesReceived = 0;
  const upstream = http.createServer((req, res) => {
    const hash = crypto.createHash("sha256");
    req.on("data", (c) => { hash.update(c); upstreamBytesReceived += c.length; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sha256: hash.digest("hex"), bytes: upstreamBytesReceived }));
    });
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  let pid;
  try {
    pid = await startProxy(`
server:
  port: ${PORT}
  workers: 2
  maxResponseBytes: 52428800
  readTimeoutMs: 60000
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
      maxBodyBytes: 209715200
`, PORT);
  } catch (err) {
    record("Large upload: 100MB streamed POST reaches upstream intact (SHA-256 match), RSS growth < 100MB", false, err.message);
    await new Promise((r) => upstream.close(r));
    return;
  }

  await sleep(300);
  const baselineRssMB = getProcessTreeRssKB(pid) / 1024;
  let peakRssMB = baselineRssMB;
  const sampler = setInterval(() => {
    const rss = getProcessTreeRssKB(pid) / 1024;
    if (rss > peakRssMB) peakRssMB = rss;
  }, 300);

  const clientHash = crypto.createHash("sha256");
  let status = 0;
  let responseBody = "";
  let uploadError = null;

  await new Promise((resolve) => {
    let stopped = false;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/upload",
        method: "POST",
        headers: { "Transfer-Encoding": "chunked", "Content-Type": "application/octet-stream" },
        timeout: 60000,
      },
      (res) => {
        status = res.statusCode;
        res.on("data", (c) => { responseBody += c; });
        res.on("end", resolve);
      },
    );
    req.on("error", (err) => { stopped = true; uploadError = err.message; resolve(); });
    req.on("timeout", () => { stopped = true; req.destroy(); uploadError = "client timeout"; resolve(); });

    const CHUNK = 1024 * 1024; // 1MB
    let sent = 0;
    function writeMore() {
      while (!stopped && sent < SIZE) {
        const remaining = SIZE - sent;
        const len = Math.min(CHUNK, remaining);
        const buf = crypto.randomBytes(len);
        clientHash.update(buf);
        sent += len;
        let ok;
        try {
          ok = req.write(buf);
        } catch (err) {
          stopped = true;
          uploadError = err.message;
          resolve();
          return;
        }
        if (!ok) {
          req.once("drain", writeMore);
          return;
        }
      }
      if (!stopped && sent >= SIZE) req.end();
    }
    writeMore();
  });

  clearInterval(sampler);
  const growthMB = peakRssMB - baselineRssMB;
  const clientDigest = clientHash.digest("hex");

  let upstreamDigest = null;
  try { upstreamDigest = JSON.parse(responseBody).sha256; } catch {}

  const ok = status === 200 && upstreamDigest === clientDigest && growthMB < 100;
  record(
    "Large upload: 100MB streamed POST reaches upstream intact (SHA-256 match), RSS growth < 100MB",
    ok,
    `Status: ${status || "n/a"}${uploadError ? ` (${uploadError})` : ""} | Client SHA-256: ${clientDigest.slice(0, 12)}… | ` +
    `Upstream SHA-256: ${upstreamDigest ? upstreamDigest.slice(0, 12) + "…" : "none"} | Upstream received: ${(upstreamBytesReceived / 1024 / 1024).toFixed(1)}MB of ${(SIZE / 1024 / 1024).toFixed(0)}MB | RSS growth: ${growthMB.toFixed(1)}MB`,
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(500);
}

// -----------------------------------------------------------------------------
// Shared CPU-usage measurement: cumulative process CPU time (ps -o time=) for
// master + every worker pid, sampled before/after firing a fixed number of
// requests. Used by both Gate 3 (master's share of the total) and Gate 4
// (total CPU per 1,000 requests, load-generator-independent — unlike RPS,
// this isn't capped by how fast this one Node process can issue HTTP calls).
// -----------------------------------------------------------------------------
async function measureProxyCpuUsage(masterPid, port, totalRequests, concurrency, pathName) {
  await sleep(500);
  const workerPidsBefore = getChildPids(masterPid);
  const cpuBefore = getCpuSecondsByPid([masterPid, ...workerPidsBefore]);

  const result = await fireFixedCount(port, totalRequests, concurrency, pathName);

  const workerPidsAfter = getChildPids(masterPid);
  const cpuAfter = getCpuSecondsByPid([masterPid, ...workerPidsAfter]);

  const masterDeltaSec = Math.max(0, (cpuAfter.get(masterPid) ?? 0) - (cpuBefore.get(masterPid) ?? 0));
  let workersDeltaSec = 0;
  for (const wp of new Set([...workerPidsBefore, ...workerPidsAfter])) {
    workersDeltaSec += Math.max(0, (cpuAfter.get(wp) ?? 0) - (cpuBefore.get(wp) ?? 0));
  }
  return {
    completed: result.completed,
    errors: result.errors,
    masterDeltaSec,
    workersDeltaSec,
    totalDeltaSec: masterDeltaSec + workersDeltaSec,
  };
}

// -----------------------------------------------------------------------------
// Gate 3: Master off the datapath — the master process accepts connections
// and routes, but should not be doing the bulk of the CPU work; that belongs
// to the worker pool actually talking to upstreams. Measured via cumulative
// process CPU time (ps -o time=) before/after 5,000 requests.
// -----------------------------------------------------------------------------
async function gate3_masterNotOnDatapath() {
  console.log(`\n${BOLD("─── GATE 3: Master Off the Datapath (CPU Share Under Load) ───")}`);
  const PORT = 9803, UP = 19803;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  let masterPid;
  try {
    masterPid = await startProxy(`
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
`, PORT);
  } catch (err) {
    record("Master CPU time stays under 10% of total proxy CPU time across 5,000 requests", false, err.message);
    await new Promise((r) => upstream.close(r));
    return;
  }

  const usage = await measureProxyCpuUsage(masterPid, PORT, 5000, 50, "/cpu-check");
  const masterShare = usage.totalDeltaSec > 0 ? usage.masterDeltaSec / usage.totalDeltaSec : 0;

  record(
    "Master CPU time stays under 10% of total proxy CPU time across 5,000 requests",
    masterShare < 0.10,
    `Completed: ${usage.completed}/5000 (errors: ${usage.errors}) | Master CPU: ${usage.masterDeltaSec.toFixed(2)}s | Workers CPU: ${usage.workersDeltaSec.toFixed(2)}s | Master share: ${(masterShare * 100).toFixed(1)}%`,
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(500);
}

// -----------------------------------------------------------------------------
// Baseline measurement for --record-baseline (RPS — kept for historical
// continuity; Gate 4 no longer reads it, see below). Same config/method as
// aggressive-fire-test.mjs's Phase 1: 10,000 requests over 100 keep-alive
// connections, rate limiting disabled, retries disabled.
// -----------------------------------------------------------------------------
function baselineProxyConfig(port, upstreamPort) {
  return `
server:
  port: ${port}
  workers: 2
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${upstreamPort}
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
`;
}

async function measureBaselineRPS() {
  const PORT = 9890, UP = 19890;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));
  await startProxy(baselineProxyConfig(PORT, UP), PORT);
  const result = await fireFixedCount(PORT, 10000, 100, "/fire1");
  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(500);
  return result;
}

const BASELINE_COMMIT = "125e1ac";
const CPU_BASELINE_TOTAL_REQUESTS = 20000;

// Config used for every CPU measurement (gate run AND baseline recording) —
// must stay identical between the two so the ratio is a fair comparison.
function cpuMeasurementProxyConfig(port, upstreamPort) {
  return `
server:
  port: ${port}
  workers: 2
  rateLimit:
    enabled: false
  upstreams:
    - id: u1
      url: http://127.0.0.1:${upstreamPort}
  paths:
    - path: /
      upstream: [u1]
`;
}

// Runs measureProxyCpuUsage() against whichever repoRoot is given (the
// current checkout, or a worktree of an older commit) and returns
// { cpuMsPerThousand, completed, errors, totalRequests }.
async function measureCpuMsPerThousand(repoRoot, port, upstreamPort, totalRequests) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));
  try {
    const masterPid = await startProxy(cpuMeasurementProxyConfig(port, upstreamPort), port, { repoRoot });
    const usage = await measureProxyCpuUsage(masterPid, port, totalRequests, 50, "/cpu-check");
    return {
      cpuMsPerThousand: (usage.totalDeltaSec * 1_000_000) / totalRequests,
      completed: usage.completed,
      errors: usage.errors,
      totalRequests,
    };
  } finally {
    stopProxy();
    await new Promise((r) => upstream.close(r));
    await sleep(500);
  }
}

// Builds a git worktree of BASELINE_COMMIT, builds it, measures its
// CPU-ms-per-1,000-requests, and tears the worktree down again — fully
// automated, so the baseline can be (re)recorded on any machine (including
// a fresh Docker container) with a single `--record-baseline` run, keyed by
// that machine's hostname+platform. node_modules is symlinked in rather
// than reinstalled: package.json/the lockfile are identical between
// BASELINE_COMMIT and HEAD (checked at the time this was written), so the
// current checkout's already-installed deps are safe to reuse and this
// avoids a slow, redundant install for a measurement that's otherwise just
// `git worktree add` + `tsc`.
async function recordCpuBaselineViaWorktree() {
  const worktreePath = path.join(os.tmpdir(), `ninja-cpu-baseline-${BASELINE_COMMIT}`);
  console.log(BOLD(`Preparing a git worktree of ${BASELINE_COMMIT} at ${worktreePath}…`));

  try { execSync(`git worktree remove "${worktreePath}" --force`, { cwd: REPO_ROOT, stdio: "ignore" }); } catch {}
  try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  try { execSync("git worktree prune", { cwd: REPO_ROOT, stdio: "ignore" }); } catch {}

  execSync(`git worktree add "${worktreePath}" ${BASELINE_COMMIT}`, { cwd: REPO_ROOT, stdio: "inherit" });

  try {
    const nodeModulesLink = path.join(worktreePath, "node_modules");
    try { fs.rmSync(nodeModulesLink, { recursive: true, force: true }); } catch {}
    fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), nodeModulesLink);

    console.log(BOLD("Building the baseline worktree…"));
    execSync("npm run build", { cwd: worktreePath, stdio: "inherit" });

    console.log(BOLD(`Measuring CPU usage over ${CPU_BASELINE_TOTAL_REQUESTS} requests on the baseline build…`));
    const result = await measureCpuMsPerThousand(worktreePath, 9895, 19895, CPU_BASELINE_TOTAL_REQUESTS);

    let baseline = {};
    try {
      baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    } catch {}
    if (!baseline.cpuBaselines) baseline.cpuBaselines = {};
    const key = machineKey();
    baseline.cpuBaselines[key] = {
      cpuMsPerThousand: result.cpuMsPerThousand,
      commit: BASELINE_COMMIT,
      totalRequests: result.totalRequests,
      completed: result.completed,
      errors: result.errors,
      date: new Date().toISOString(),
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      method: IS_LINUX
        ? "git worktree, 2 workers, fixed-count requests over 50 keep-alive connections, cumulative CPU time from /proc/<pid>/stat summed across master+worker pids before/after, normalized to ms per 1,000 requests"
        : "git worktree, 2 workers, fixed-count requests over 50 keep-alive connections, cumulative CPU time from `ps -o time=` summed across master+worker pids before/after, normalized to ms per 1,000 requests",
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(G(`Saved CPU baseline for "${key}": ${result.cpuMsPerThousand.toFixed(1)}ms/1k → ${path.relative(REPO_ROOT, BASELINE_FILE)}`));
    console.log(JSON.stringify(baseline.cpuBaselines[key], null, 2));
  } finally {
    try { execSync(`git worktree remove "${worktreePath}" --force`, { cwd: REPO_ROOT, stdio: "ignore" }); } catch {}
  }
}

async function recordBaseline() {
  console.log(BOLD("Measuring fixed-count baseline RPS (test:fire Phase 1 equivalent: 10,000 requests / 100 keep-alive connections)…"));
  console.log(Y("(Informational only — Gate 4 does not use this field, see cpuBaselines below.)"));
  const result = await measureBaselineRPS();
  let baseline = {};
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
  } catch {}
  baseline.rps = result.rps;
  baseline.completed = result.completed;
  baseline.errors = result.errors;
  baseline.elapsedSec = result.elapsedSec;
  baseline.date = new Date().toISOString();
  baseline.machine = `${os.hostname()} (${os.platform()}/${os.arch()}, ${os.cpus().length} cpus)`;
  baseline.node = process.version;
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(G(`Saved informational RPS baseline: ${baseline.rps.toFixed(0)} req/s → ${path.relative(REPO_ROOT, BASELINE_FILE)}`));

  console.log("");
  await recordCpuBaselineViaWorktree();
}

// -----------------------------------------------------------------------------
// Gate 4: CPU efficiency — total proxy CPU time (master + all workers) per
// 1,000 requests must be at or under 1.0x this machine's baseline in
// tests/perf-baseline.json's cpuBaselines[hostname:platform] entry.
//
// This replaces an earlier RPS-based gate (measured loaded.rps against a
// fixed multiple of a pinned baseline RPS). That approach was dropped: this
// harness's own HTTP client, not the proxy, turned out to be the ceiling —
// the same 100-keep-alive-connection load generator sustains ~27,000 req/s
// against a bare `http.createServer` echo (no proxy at all) on this
// machine, 3-4x anything ever measured against the proxy, so the RPS
// numbers were mostly measuring the test harness, not the code under test.
// CPU-ms per 1,000 requests has no such ceiling — it's measured directly
// from the OS (ps -o time= on macOS, /proc/<pid>/stat on Linux) and is
// independent of how fast any one client can fire requests.
//
// The baseline is keyed per-machine (hostname+platform) because raw CPU-ms
// is not portable across machines with different core speeds — run
// `node tests/production-gates.mjs --record-baseline` once on each machine
// this suite is meant to gate on (it automates building a git worktree of
// BASELINE_COMMIT and measuring it the same way). Gate 4 fails clearly,
// rather than silently comparing against the wrong machine's numbers, if
// this machine has never recorded one.
// -----------------------------------------------------------------------------
async function gate4_cpuEfficiency() {
  console.log(`\n${BOLD("─── GATE 4: CPU Efficiency ≤ 1.0x this machine's baseline ────")}`);
  const key = machineKey();
  const GATE_NAME = `Proxy CPU time per 1,000 requests is at or under 1.0x this machine's baseline (tests/perf-baseline.json, key "${key}")`;

  if (!fs.existsSync(BASELINE_FILE)) {
    record(GATE_NAME, false, `No baseline file at ${path.relative(REPO_ROOT, BASELINE_FILE)} — run "node tests/production-gates.mjs --record-baseline" on this machine first.`);
    return;
  }
  let baselineFile;
  try {
    baselineFile = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
  } catch (err) {
    record(GATE_NAME, false, `Baseline file at ${path.relative(REPO_ROOT, BASELINE_FILE)} is not valid JSON: ${err.message}`);
    return;
  }
  const baseline = baselineFile?.cpuBaselines?.[key];
  if (!baseline || typeof baseline.cpuMsPerThousand !== "number" || !(baseline.cpuMsPerThousand > 0)) {
    record(
      GATE_NAME,
      false,
      `No baseline recorded for this machine (key "${key}") in tests/perf-baseline.json's cpuBaselines — run "node tests/production-gates.mjs --record-baseline" on this machine first.`,
    );
    return;
  }

  const measured = await measureCpuMsPerThousand(REPO_ROOT, 9804, 19804, CPU_BASELINE_TOTAL_REQUESTS);
  const required = baseline.cpuMsPerThousand * 1.0;

  record(
    GATE_NAME,
    measured.cpuMsPerThousand <= required,
    `Baseline for "${key}": ${baseline.cpuMsPerThousand.toFixed(1)}ms/1k (commit ${baseline.commit}, recorded ${baseline.date}) | ` +
    `Measured: ${measured.cpuMsPerThousand.toFixed(1)}ms/1k over ${measured.totalRequests} requests (${measured.completed} completed, ${measured.errors} errors) | Required: <=${required.toFixed(1)}ms/1k`,
  );
}

// -----------------------------------------------------------------------------
// Gate 5: Rate limit across workers — a global per-IP limit (maxRequests=100)
// must hold even though the proxy runs 4 worker processes. All requests come
// from this harness, so they all share one source IP (127.0.0.1) by
// construction — no header spoofing needed.
// -----------------------------------------------------------------------------
async function gate5_rateLimitAcrossWorkers() {
  console.log(`\n${BOLD("─── GATE 5: Rate Limit Shared Across Workers ──────────────────")}`);
  const PORT = 9805, UP = 19805;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(UP, "127.0.0.1", r));

  try {
    await startProxy(`
server:
  port: ${PORT}
  workers: 4
  rateLimit:
    enabled: true
    storage: memory
    algorithm: fixed-window
    windowMs: 60000
    maxRequests: 100
  upstreams:
    - id: u1
      url: http://127.0.0.1:${UP}
  paths:
    - path: /
      upstream: [u1]
`, PORT);
  } catch (err) {
    record("Rate limit (maxRequests=100) holds across 4 workers for a single IP (100 ± 10 of 400 allowed)", false, err.message);
    await new Promise((r) => upstream.close(r));
    return;
  }

  const TOTAL = 400;
  const CONCURRENCY = 20;
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  let issued = 0, allowed = 0, blocked = 0, other = 0;

  async function workerLoop() {
    while (true) {
      const mySlot = ++issued;
      if (mySlot > TOTAL) break;
      await new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: PORT, path: "/rl-check", agent, timeout: 6000 }, (res) => {
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
  record(
    "Rate limit (maxRequests=100) holds across 4 workers for a single IP (100 ± 10 of 400 allowed, not ~400)",
    withinBand,
    `Allowed: ${allowed}/${TOTAL} | Blocked (429): ${blocked} | Other: ${other}`,
  );

  stopProxy();
  await new Promise((r) => upstream.close(r));
  await sleep(500);
}

// -----------------------------------------------------------------------------
// Main Orchestration
// -----------------------------------------------------------------------------
async function main() {
  console.log("\n" + BOLD("═".repeat(70)));
  console.log(BOLD("  🚦 PRODUCTION GATE SUITE — NINJA REVERSE PROXY"));
  console.log(BOLD("═".repeat(70)));

  const t0 = performance.now();
  const gates = [
    ["Gate 1", gate1_slowClientMemory],
    ["Gate 2", gate2_largeUpload],
    ["Gate 3", gate3_masterNotOnDatapath],
    ["Gate 4", gate4_cpuEfficiency],
    ["Gate 5", gate5_rateLimitAcrossWorkers],
  ];
  for (const [name, fn] of gates) {
    try {
      await fn();
    } catch (err) {
      console.error(R(`\n${name} threw: ${err.stack || err.message}`));
      record(`${name} crashed instead of completing`, false, err.message);
      stopProxy();
    }
  }
  try {
    const files = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("_gate_cfg_"));
    for (const f of files) fs.unlinkSync(path.join(os.tmpdir(), f));
  } catch {}
  try { fs.unlinkSync(path.join(REPO_ROOT, "proxy_registry_backup.json")); } catch {}

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  console.log("\n" + BOLD("═".repeat(70)));
  console.log(BOLD("  📊 PRODUCTION GATE SCORECARD"));
  console.log(BOLD("═".repeat(70)));

  let passed = 0;
  for (const r of results) {
    if (r.passed) passed++;
    const status = r.passed ? G("PASSED") : R("FAILED");
    console.log(`  ${r.name.padEnd(90)} [${status}]`);
  }

  console.log("─".repeat(70));
  console.log(`  Total Passed: ${passed}/${results.length} | Total Runtime: ${elapsed}s`);
  console.log(BOLD("═".repeat(70)) + "\n");

  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv.includes("--record-baseline")) {
  recordBaseline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(R(`Baseline recording failed: ${err.stack || err.message}`));
      stopProxy();
      process.exit(1);
    });
} else {
  main();
}
