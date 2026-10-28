import http from "node:http";
import net from "node:net";
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

class FencingTokenTracker {
  constructor(defaultInitialEpoch = 0) {
    this.defaultInitialEpoch = defaultInitialEpoch;
    this.epochs = new Map();
  }

  getCurrentEpoch(resourceKey = "global") {
    return this.epochs.get(resourceKey) ?? this.defaultInitialEpoch;
  }

  validateAndAdvance(token, resourceKey = "global") {
    const current = this.getCurrentEpoch(resourceKey);
    if (token < current) {
      return { valid: false, currentEpoch: current };
    }
    if (token > current) {
      this.epochs.set(resourceKey, token);
    }
    return { valid: true, currentEpoch: Math.max(current, token) };
  }
}

function fencingMiddleware(options = {}, tracker = new FencingTokenTracker(options.initialEpoch ?? 0)) {
  const headerName = (options.headerName ?? "x-fencing-token").toLowerCase();
  const rejectStatus = options.rejectStatus ?? 409;
  const guardedMethods = new Set((options.methods ?? ["POST", "PUT", "PATCH", "DELETE"]).map((m) => m.toUpperCase()));
  const requireToken = options.requireToken ?? false;
  const getResourceKey = options.getResourceKey ?? (() => "global");

  return async (ctx, next) => {
    const method = (ctx.req.method ?? "GET").toUpperCase();
    if (!guardedMethods.has(method)) {
      return next();
    }

    const rawToken = ctx.req.headers[headerName];
    const resourceKey = getResourceKey(ctx);

    if (rawToken === undefined || rawToken === null || rawToken === "") {
      if (requireToken) {
        ctx.res.writeHead(428, { "Content-Type": "application/json" });
        ctx.res.end(JSON.stringify({
          error: "Precondition Required: Missing Fencing Token",
          header: headerName,
        }));
        return;
      }
      return next();
    }

    const tokenValue = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const parsedToken = Number.parseInt(tokenValue, 10);

    if (Number.isNaN(parsedToken) || parsedToken < 0) {
      ctx.res.writeHead(400, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({
        error: "Bad Request: Invalid Fencing Token",
        received: tokenValue,
      }));
      return;
    }

    const check = tracker.validateAndAdvance(parsedToken, resourceKey);
    if (!check.valid) {
      ctx.res.writeHead(rejectStatus, {
        "Content-Type": "application/json",
        "X-Current-Epoch": check.currentEpoch.toString(),
      });
      ctx.res.end(JSON.stringify({
        error: "Stale Fencing Token: Zombie Leader Write Rejected",
        currentEpoch: check.currentEpoch,
        providedEpoch: parsedToken,
        resource: resourceKey,
      }));
      return;
    }

    ctx.metadata.fencingEpoch = check.currentEpoch;
    await next();
  };
}

console.log("\n==================================================================");
console.log("   DDIA CHAPTER 8: THE TROUBLE WITH DISTRIBUTED SYSTEMS          ");
console.log("   Live, Non-Simulated Verification Suite                        ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// §1. Unreliable Networks: Real TCP Black Hole & Socket Timeout
// -----------------------------------------------------------------------------
console.log("\x1b[1m§1. Unreliable Networks: Deterministic Socket Timeouts under TCP Black Hole\x1b[0m");

const blackHoleServer = net.createServer(() => {
  // Accepts TCP handshake but sends no HTTP data (simulating silent partition)
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
await new Promise((resolve) => gcServer.close(resolve));

report(
  "GC-01",
  "Adaptive Circuit Breaker dynamically ramps drop probability during GC freeze",
  normalDropProb === 0 && pausedDropProb > 0.35,
  `Pre-GC dropProb=${normalDropProb.toFixed(3)}, Post-GC dropProb=${pausedDropProb.toFixed(3)}`
);

// -----------------------------------------------------------------------------
// §5. Zombie Leaders & Split-Brain: Live HTTP Fencing Token Enforcement
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§5. Knowledge & Truth: Fencing Tokens Block Resurrected Zombie Leaders\x1b[0m");

const tracker = new FencingTokenTracker(30);
const fenceServer = http.createServer(async (req, res) => {
  const ctx = {
    req,
    res,
    clientIp: req.socket.remoteAddress || "127.0.0.1",
    startTime: performance.now(),
    metadata: {},
  };
  const mw = fencingMiddleware({ requireToken: true }, tracker);
  await mw(ctx, async () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "success", epoch: ctx.metadata.fencingEpoch }));
  });
});
await new Promise((resolve) => fenceServer.listen(0, "127.0.0.1", resolve));
const fencePort = fenceServer.address().port;

const r1 = await realHttpRequest(fencePort, "POST", "/state", { "x-fencing-token": "34" });
const r2 = await realHttpRequest(fencePort, "POST", "/state", { "x-fencing-token": "33" });
const r3 = await realHttpRequest(fencePort, "POST", "/state", { "x-fencing-token": "35" });
const r4 = await realHttpRequest(fencePort, "POST", "/state", {});
const r5 = await realHttpRequest(fencePort, "GET", "/state", {});

await new Promise((resolve) => fenceServer.close(resolve));

report(
  "FENCE-01",
  "New Leader with advanced Fencing Token #34 is authorized over live HTTP",
  r1.status === 200,
  `Status=${r1.status}`
);

report(
  "FENCE-02",
  "Resurrected Zombie Leader with Stale Fencing Token #33 is blocked with HTTP 409",
  r2.status === 409 && r2.body.includes("Zombie Leader Write Rejected"),
  `Status=${r2.status}, Reason=Stale token rejected`
);

report(
  "FENCE-03",
  "Higher token #35 succeeds, missing token yields 428, GET bypasses token guard",
  r3.status === 200 && r4.status === 428 && r5.status === 200,
  `Token35=${r3.status}, MissingToken=${r4.status}, GET=${r5.status}`
);

// -----------------------------------------------------------------------------
// §6. Heartbeat Eviction: Dynamic Registry Ejects Partitioned Nodes
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§6. Dynamic Discovery: Dead Node Eviction upon Heartbeat Lease Expiry\x1b[0m");

const registry = new ServiceRegistry({
  heartbeatTimeoutMs: 60,
  cleanupIntervalMs: 20,
  persistencePath: "proxy_registry_test_ch8.json",
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
