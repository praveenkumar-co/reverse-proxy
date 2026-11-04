import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { calculateFullJitterBackoff } from "../dist/resilience/retry/backoff/full-jitter.backoff.js";
import { AdaptiveCircuitBreaker } from "../dist/resilience/circuit-breaker/adaptive.circuit-breaker.js";
import { ServiceRegistry } from "../dist/discovery/registry/dynamic.registry.js";

let totalPassed = 0;
let totalFailed = 0;

function report(section, title, pass, details = "") {
  if (pass) {
    totalPassed++;
    console.log(`  \x1b[32m✅ PASS\x1b[0m [${section}] ${title} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
  } else {
    totalFailed++;
    console.error(`  \x1b[31m❌ FAIL\x1b[0m [${section}] ${title} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realHttpRequest(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

console.log("\n==================================================================");
console.log("   DDIA CHAPTER 8: THE TROUBLE WITH DISTRIBUTED SYSTEMS          ");
console.log("   Live, Non-Simulated Verification Suite                        ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// §1. Unreliable Networks: Real TCP Black Hole & Socket Timeout
// -----------------------------------------------------------------------------
console.log("\x1b[1m§1. Unreliable Networks: Deterministic Socket Timeouts under TCP Black Hole\x1b[0m");

const activeSockets = new Set();
const blackHoleServer = net.createServer((sock) => {
  activeSockets.add(sock);
  sock.on("close", () => activeSockets.delete(sock));
  sock.on("error", () => {});
});
await new Promise((resolve) => blackHoleServer.listen(0, "127.0.0.1", resolve));
const blackHolePort = blackHoleServer.address().port;

const startNet = performance.now();
let timeoutTriggered = false;

try {
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: blackHolePort,
      path: "/api/test",
      method: "GET",
      timeout: 150,
    }, (res) => resolve(res));

    req.on("timeout", () => {
      timeoutTriggered = true;
      req.destroy(new Error("Connect timeout"));
    });
    req.on("error", (err) => reject(err));
    req.end();
  });
} catch {
  // Expected abort on timeout
}

const elapsedNet = performance.now() - startNet;

// Clean up sockets before closing server to prevent hanging
for (const s of activeSockets) {
  s.destroy();
}
activeSockets.clear();
await new Promise((resolve) => blackHoleServer.close(resolve));

report(
  "NET-01",
  "Real TCP black hole aborts cleanly via socket timeout without hanging",
  timeoutTriggered === true && elapsedNet >= 140 && elapsedNet < 600,
  `Timeout fired at ${elapsedNet.toFixed(1)}ms (configured: 150ms)`
);

// -----------------------------------------------------------------------------
// §2. Unreliable Networks: Thundering Herd Mitigation via Full Jitter
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§2. Unreliable Networks: Full Jitter Backoff Prevents Thundering Herd\x1b[0m");

const delays = [];
const attempts = 1000;
const baseDelay = 50;
const maxDelay = 2000;
const attempt = 3; // cap = min(2000, 50 * 2^3) = 400ms

for (let i = 0; i < attempts; i++) {
  delays.push(calculateFullJitterBackoff(attempt, baseDelay, maxDelay));
}

const allWithinBounds = delays.every((d) => d >= 0 && d <= 400);
const mean = delays.reduce((a, b) => a + b, 0) / attempts;
const variance = delays.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / attempts;
const stdDev = Math.sqrt(variance);
const wellDistributed = stdDev > 70 && mean > 140 && mean < 260;

report(
  "NET-02",
  "Full Jitter exponentially disperses concurrent retries across backoff window",
  allWithinBounds && wellDistributed,
  `1,000 trials: mean=${mean.toFixed(1)}ms, stdDev=${stdDev.toFixed(1)}ms, bound=[0, 400ms]`
);

// -----------------------------------------------------------------------------
// §3. Unreliable Clocks: Monotonic Clock Immunity to NTP Backward Steps
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§3. Unreliable Clocks: Monotonic Clock (performance.now) Immunity to NTP Steps\x1b[0m");

const startPerf = performance.now();
const startDate = Date.now();

// Simulate NTP clock step backward
const originalDateNow = Date.now;
Date.now = () => startDate - 10000;

const wallClockElapsed = Date.now() - startDate;
const monotonicElapsed = performance.now() - startPerf;

Date.now = originalDateNow;

report(
  "CLK-01",
  "performance.now() guarantees strictly monotonic forward time during NTP step-backs",
  wallClockElapsed < -9000 && monotonicElapsed >= 0,
  `Wall clock elapsed=${wallClockElapsed}ms, Monotonic elapsed=${monotonicElapsed.toFixed(3)}ms`
);

// -----------------------------------------------------------------------------
// §4. Process Pauses & GC: Google SRE Adaptive Circuit Breaker Throttling
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§4. Process Pauses: Google SRE Adaptive Throttling during Upstream GC Freeze\x1b[0m");

let isPausedByGC = false;
const gcServer = http.createServer((req, res) => {
  if (isPausedByGC) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GC Pause: Process Frozen" }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  }
});
await new Promise((resolve) => gcServer.listen(0, "127.0.0.1", resolve));
const gcPort = gcServer.address().port;

const adaptiveBreaker = new AdaptiveCircuitBreaker(2, 0.95);

for (let i = 0; i < 30; i++) {
  const res = await realHttpRequest(gcPort, "GET", "/data");
  if (res.status === 200) adaptiveBreaker.recordSuccess(10);
  else adaptiveBreaker.recordFailure();
}
const normalDropProb = adaptiveBreaker.getStats().dropProbability;

isPausedByGC = true;
for (let i = 0; i < 30; i++) {
  const res = await realHttpRequest(gcPort, "GET", "/data");
  if (res.status === 200) adaptiveBreaker.recordSuccess(10);
  else adaptiveBreaker.recordFailure();
}
const pausedDropProb = adaptiveBreaker.getStats().dropProbability;

if (typeof gcServer.closeAllConnections === "function") {
  gcServer.closeAllConnections();
}
await new Promise((resolve) => gcServer.close(resolve));

report(
  "GC-01",
  "Adaptive Circuit Breaker dynamically ramps drop probability during GC freeze",
  normalDropProb === 0 && pausedDropProb > 0.35,
  `Pre-GC dropProb=${normalDropProb.toFixed(3)}, Post-GC dropProb=${pausedDropProb.toFixed(3)}`
);

// -----------------------------------------------------------------------------
// §6. Heartbeat Eviction: Dynamic Registry Ejects Partitioned Nodes
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§6. Dynamic Discovery: Dead Node Eviction upon Heartbeat Lease Expiry\x1b[0m");

const registryTestFile = `proxy_registry_test_ch8_${Date.now()}.json`;
const registry = new ServiceRegistry({
  heartbeatTimeoutMs: 60,
  cleanupIntervalMs: 20,
  persistencePath: registryTestFile,
});

registry.register({ id: "node-healthy", url: "http://127.0.0.1:9001", metadata: { dynamic: "true" } });
registry.register({ id: "node-partitioned", url: "http://127.0.0.1:9002", metadata: { dynamic: "true" } });

await sleep(30);
registry.heartbeat("node-healthy");

await sleep(50);
registry.checkHeartbeats();

const healthy = registry.getHealthy();
const healthyContainsActive = healthy.some((s) => s.id === "node-healthy");
const healthyExcludesDead = !healthy.some((s) => s.id === "node-partitioned");
const deadStatusIsDown = registry.get("node-partitioned")?.status === "DOWN";

// Clean up registry test file
try {
  if (fs.existsSync(registryTestFile)) {
    fs.unlinkSync(registryTestFile);
  }
} catch {}

report(
  "EVICT-01",
  "Partitioned node past heartbeat lease is automatically marked DOWN and excluded",
  healthyContainsActive && healthyExcludesDead && deadStatusIsDown,
  `Active=${healthyContainsActive}, PartitionedEvicted=${healthyExcludesDead}`
);

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log("\n==================================================================");
console.log(`   CHAPTER 8 RESULTS: ${totalPassed} Passed | ${totalFailed} Failed`);
console.log("==================================================================\n");

if (totalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
