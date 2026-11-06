// =============================================================================
// CHAOS RESILIENCE SUITE
// =============================================================================
// Targeted automated verification for the 5 adversarial failure surfaces from
// the chaos-hardening pass: client-abort socket leaks, WebSocket error
// symmetry, circuit-breaker probe-leak protection, JSON.parse crash traps,
// and graceful SIGTERM drain. Each section is independent and spins up only
// what it needs.
// =============================================================================

import { spawn, execSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "./helpers/kill-process-tree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const results = [];
function record(section, name, passed, detail = "") {
  results.push({ section, name, passed, detail });
  const icon = passed ? "\x1b[32m✅ PASS\x1b[0m" : "\x1b[31m❌ FAIL\x1b[0m";
  console.log(`  ${icon}  [${section}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------------
// Section 3: Circuit Breaker Probe-Leak Protection — direct class-level test,
// deterministic and fast (no network needed; this is exactly what the fix
// touches: ClassicCircuitBreaker.cancelProbe / recordSuccess / recordFailure).
// ----------------------------------------------------------------------------
async function testCircuitBreakerProbeLeak() {
  console.log("\n--- Section 3: Circuit Breaker Probe-Leak Protection ---");
  const { ClassicCircuitBreaker } = await import("../dist/resilience/circuit-breaker/classic.circuit-breaker.js");

  // Trip to OPEN, then wait past recovery so the next isAllowed() grants a HALF_OPEN probe.
  const cb = new ClassicCircuitBreaker(1, 50, 1); // failureThreshold=1, recoveryTimeMs=50ms, maxHalfOpenProbes=1
  cb.recordFailure(); // trips OPEN
  await sleep(80);
  const grantedProbe = cb.isAllowed(); // OPEN -> HALF_OPEN, grants the 1 slot
  const secondRequestDenied = !cb.isAllowed(); // slot already taken — must be denied

  record(
    "3. Circuit Breaker",
    "HALF_OPEN grants exactly 1 probe, denies concurrent others",
    grantedProbe && secondRequestDenied,
    `granted=${grantedProbe}, concurrent-denied=${secondRequestDenied}`,
  );

  // Simulate the bulkhead-rejection scenario: the probe was granted but the request never
  // reached the upstream at all — cancelProbe() must release the slot neutrally.
  cb.cancelProbe();
  const probeAvailableAgain = cb.isAllowed();
  record(
    "3. Circuit Breaker",
    "cancelProbe() releases a slot abandoned before dispatch (bulkhead-rejection case)",
    probeAvailableAgain,
    `probe re-grantable after cancelProbe=${probeAvailableAgain}`,
  );

  // Never goes negative / stuck: hammer cancelProbe with nothing in flight.
  const cb2 = new ClassicCircuitBreaker(1, 10, 1);
  cb2.recordFailure();
  await sleep(20);
  cb2.isAllowed(); // grants the one probe
  cb2.cancelProbe();
  cb2.cancelProbe(); // extra calls must be safe no-ops, not go negative
  cb2.cancelProbe();
  const stillGrantsExactlyOne = cb2.isAllowed() && !cb2.isAllowed();
  record(
    "3. Circuit Breaker",
    "Redundant cancelProbe() calls are safe no-ops (never goes negative)",
    stillGrantsExactlyOne,
    `still grants exactly one probe after redundant cancels=${stillGrantsExactlyOne}`,
  );

  // recordFailure/recordSuccess both release the slot (the direct ask from the task).
  const cb3 = new ClassicCircuitBreaker(1, 10, 1);
  cb3.recordFailure();
  await sleep(20);
  cb3.isAllowed();
  cb3.recordSuccess(5);
  const releasedBySuccess = cb3.getState() === "CLOSED";
  record("3. Circuit Breaker", "recordSuccess() releases the probe slot and closes the breaker", releasedBySuccess);

  const cb4 = new ClassicCircuitBreaker(1, 10, 1);
  cb4.recordFailure();
  await sleep(20);
  cb4.isAllowed();
  cb4.recordFailure(); // the probe itself failed — re-trips OPEN, slot released as a side effect
  const retrippedByFailure = cb4.getState() === "OPEN";
  record("3. Circuit Breaker", "recordFailure() on a failed probe re-trips OPEN and releases the slot", retrippedByFailure);
}

// ----------------------------------------------------------------------------
// Section 4: JSON Parse Crash Traps — malformed bodies to real endpoints must
// never crash the process or hang; the proxy must stay responsive afterward.
// ----------------------------------------------------------------------------
async function testJsonParseCrashTraps(proxyPort, proxyProc) {
  console.log("\n--- Section 4: JSON Parse Crash Traps ---");

  function rawRequest(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, path: urlPath, method, headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  const malformedTargets = [
    { path: "/__cache/purge/tag", headers: { "x-admin-token": "chaos-admin-secret" } },
    { path: "/__cache/purge/pattern", headers: { "x-admin-token": "chaos-admin-secret" } },
    { path: "/__registry/register", headers: {} },
  ];

  let allSurvived = true;
  const statuses = [];
  for (const target of malformedTargets) {
    try {
      const res = await rawRequest("POST", target.path, "{not-valid-json!!", {
        "Content-Type": "application/json",
        ...target.headers,
      });
      statuses.push(`${target.path}=${res.status}`);
      if (res.status >= 500) allSurvived = false;
    } catch (err) {
      statuses.push(`${target.path}=ERROR(${err.message})`);
      allSurvived = false;
    }
  }

  record(
    "4. JSON Parse Crash Traps",
    "Malformed JSON bodies to admin endpoints return clean 4xx, not a crash",
    allSurvived,
    statuses.join(", "),
  );

  // The process itself must still be alive and the event loop responsive.
  const stillAlive = proxyProc.exitCode === null && !proxyProc.killed;
  let stillResponsive = false;
  try {
    const res = await rawRequest("GET", "/__ready", "", {});
    stillResponsive = res.status === 200 || res.status === 403 || res.status === 503;
  } catch {
    stillResponsive = false;
  }
  record(
    "4. JSON Parse Crash Traps",
    "Proxy process survives malformed input and remains responsive",
    stillAlive && stillResponsive,
    `process-alive=${stillAlive}, still-responding=${stillResponsive}`,
  );
}

// ----------------------------------------------------------------------------
// Section 1: Socket & Client Abort Leaks — a client that disconnects while the
// upstream is still streaming must not leave that upstream connection hanging
// forever; proxy-reported active connections for that upstream must drop back
// to 0 shortly after the abort, not stay stuck.
// ----------------------------------------------------------------------------
async function testClientAbortLeak(proxyPort, adminToken) {
  console.log("\n--- Section 1: Socket & Client Abort Leaks ---");

  function getLbStats() {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/__lb-stats", method: "GET", headers: { "x-admin-token": adminToken } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function activeConnectionsFor(stats, upstreamId) {
    const entry = stats.upstreams?.find((u) => u.id === upstreamId);
    return entry?.activeConnections ?? -1;
  }

  // Fire a request to the slow-abort-test upstream (responds after 3s) and abort the client
  // connection after 200ms — well before the upstream would have replied.
  const abortedSocket = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/abort-test", method: "GET" },
      () => {},
    );
    req.on("error", () => {});
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve(true);
    }, 200);
  });

  await sleep(500); // give the proxy's close handler time to process the abort
  const statsAfterAbort = await getLbStats().catch(() => null);
  const activeAfterAbort = statsAfterAbort ? activeConnectionsFor(statsAfterAbort, "abort-backend") : -1;

  record(
    "1. Client Abort Leaks",
    "Active connection count for the aborted upstream drops back to 0 (not stuck)",
    abortedSocket && activeAfterAbort === 0,
    `active-connections-after-abort=${activeAfterAbort}`,
  );
}

// ----------------------------------------------------------------------------
// Section 2: WebSocket Lifecycle & Error Handling — connecting to a WS route
// whose upstream refuses the connection must not crash the process, and must
// cleanly close the client socket.
// ----------------------------------------------------------------------------
async function testWebSocketErrorHandling(proxyPort, proxyProc) {
  console.log("\n--- Section 2: WebSocket Lifecycle & Error Handling ---");

  const outcome = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(
        "GET /ws-test HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };
    socket.on("close", () => finish("closed"));
    socket.on("error", () => finish("errored"));
    setTimeout(() => finish("timeout"), 3000);
  });

  await sleep(300);
  const stillAlive = proxyProc.exitCode === null && !proxyProc.killed;
  record(
    "2. WebSocket Error Handling",
    "Upgrade to a route whose upstream refuses the connection doesn't crash the proxy",
    stillAlive && outcome !== "timeout",
    `client-socket-outcome=${outcome}, proxy-process-alive=${stillAlive}`,
  );
}

// ----------------------------------------------------------------------------
// Section 5: Graceful Drain on SIGTERM — spun up as its own isolated proxy
// instance (shutdown is terminal, so this can't share the suite's main proxy).
// ----------------------------------------------------------------------------
async function testGracefulShutdown() {
  console.log("\n--- Section 5: Graceful Drain on SIGTERM ---");

  const port = 8697;
  const mockPort = 4797;
  const tmpConfig = path.join(os.tmpdir(), `ninja-chaos-shutdown-config-${process.pid}.yaml`);
  const configYaml = `
server:
  listen: ${port}
  workers: 1
tls:
  enabled: false
admin:
  enabled: false
upstreams:
  - id: slow
    url: "http://127.0.0.1:${mockPort}"
    healthPath: "/health"
routes:
  - path: "/"
    upstreams: ["slow"]
    cache: { enabled: false }
rateLimit:
  enabled: false
cache:
  enabled: false
`;
  fs.writeFileSync(tmpConfig, configYaml, "utf8");

  const mock = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    // Deliberately slow (1.5s) so we can catch it genuinely in-flight when SIGTERM fires.
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("slow-response-completed");
    }, 1500);
  });
  await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));

  const proxyLogPath = path.join(os.tmpdir(), `ninja-chaos-shutdown-proxy-${process.pid}.log`);
  const logFd = fs.openSync(proxyLogPath, "a");
  const proxy = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", tmpConfig], {
    cwd: REPO_ROOT,
    stdio: ["ignore", logFd, logFd],
  });

  // Can't use the slow route to probe readiness (it'd hang 1.5s each poll) — poll via raw connect.
  async function waitListening(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const connected = await new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port }, () => {
          s.destroy();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      if (connected) return true;
      await sleep(200);
    }
    return false;
  }

  const isListening = await waitListening(20000);
  await sleep(1000); // let initial health check / startHealthChecks settle

  let inFlightResult = null;
  let shutdownExitInfo = null;
  if (isListening) {
    // Fire the slow request, then SIGTERM shortly after — it must still complete, not be cut off.
    const inFlightPromise = new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 10000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", (err) => resolve({ error: err.message }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ error: "client timeout" });
      });
      req.end();
    });

    await sleep(200); // ensure the request is genuinely in flight before signaling shutdown
    const shutdownStart = Date.now();
    proxy.kill("SIGTERM");

    const exitPromise = new Promise((resolve) => {
      proxy.once("exit", (code, signal) => resolve({ code, signal, elapsedMs: Date.now() - shutdownStart }));
    });

    [inFlightResult, shutdownExitInfo] = await Promise.all([
      inFlightPromise,
      Promise.race([exitPromise, sleep(15000).then(() => ({ code: null, signal: "TIMEOUT", elapsedMs: 15000 }))]),
    ]);
  }

  // Safety-net only -- the 15s race above already gave the graceful SIGTERM drain this test
  // is specifically measuring every chance to finish on its own. If it still didn't, a plain
  // kill() of just this top-level pid would leave any forked worker orphaned (confirmed
  // elsewhere in this phase: killing only the master never reaches a worker it already told
  // to drain), so fall back to the shared tree-kill helper instead of a single kill() here.
  // Must happen BEFORE mock.close() -- if the proxy is still alive (the race above timed
  // out), its own pooled connection to mock is what would otherwise keep mock.close() from
  // ever resolving (confirmed directly in datapath-regression.mjs's cleanup()).
  await killProcessTree(proxy, { signal: "SIGKILL", graceMs: 0 });
  await mock.close();
  try {
    fs.unlinkSync(tmpConfig);
  } catch {}

  let logContent = "";
  try {
    logContent = fs.readFileSync(proxyLogPath, "utf8");
  } catch {}
  const allLines = logContent.split("\n");
  const sigtermIndex = allLines.findIndex((l) => l.includes("Received SIGTERM"));
  const linesAfterSigterm = sigtermIndex !== -1 ? allLines.slice(sigtermIndex) : [];
  const healthChecksStoppedPromptly = !linesAfterSigterm.some((line) => line.includes("Checking all upstreams"));

  record(
    "5. Graceful SIGTERM Drain",
    "In-flight slow request completes successfully despite SIGTERM arriving mid-request",
    inFlightResult?.status === 200 && inFlightResult?.body === "slow-response-completed",
    `in-flight result=${JSON.stringify(inFlightResult)}`,
  );
  record(
    "5. Graceful SIGTERM Drain",
    "Process exits with code 0 after draining",
    shutdownExitInfo?.code === 0,
    `exit=${JSON.stringify(shutdownExitInfo)}`,
  );
  record(
    "5. Graceful SIGTERM Drain",
    "No further health-check activity logged right before exit (interval was cleared)",
    healthChecksStoppedPromptly,
  );

  try {
    fs.unlinkSync(proxyLogPath);
  } catch {}
}

// ----------------------------------------------------------------------------
// Main orchestration for sections 1, 2, 4 (shared proxy instance); section 3
// is standalone (direct class import); section 5 spins up its own instance.
// ----------------------------------------------------------------------------
async function main() {
  await testCircuitBreakerProbeLeak();

  const proxyPort = 8599;
  const adminToken = "chaos-admin-secret";
  const ports = { fast: 4790, abort: 4791, ws: 4792 };
  const tmpConfig = path.join(os.tmpdir(), `ninja-chaos-config-${process.pid}.yaml`);

  const abortBackend = http.createServer((req, res) => {
    const timer = setTimeout(() => {
      res.writeHead(200);
      res.end("too-late");
    }, 3000);
    req.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => abortBackend.listen(ports.abort, "127.0.0.1", resolve));

  const fastBackend = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => fastBackend.listen(ports.fast, "127.0.0.1", resolve));

  // Must be a real, passing-health-check backend (so the circuit/health layer doesn't fall
  // back to routing this test's upgrade at some other healthy upstream instead) that then
  // explicitly refuses the WS upgrade itself, to deterministically exercise the "upstream
  // socket errors during the handshake" path rather than "upstream unreachable at all."
  const wsBackend = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  wsBackend.on("upgrade", (_req, socket) => {
    socket.destroy();
  });
  await new Promise((resolve) => wsBackend.listen(ports.ws, "127.0.0.1", resolve));

  const configYaml = `
server:
  listen: ${proxyPort}
  workers: 2
tls:
  enabled: false
admin:
  enabled: true
  token: "${adminToken}"
upstreams:
  - id: fast
    url: "http://127.0.0.1:${ports.fast}"
    healthPath: "/"
  - id: abort-backend
    url: "http://127.0.0.1:${ports.abort}"
    healthPath: "/"
  - id: ws-backend
    url: "http://127.0.0.1:${ports.ws}"
    healthPath: "/"
routes:
  - path: "/abort-test"
    upstreams: ["abort-backend"]
    cache: { enabled: false }
  - path: "/ws-test"
    upstreams: ["ws-backend"]
    cache: { enabled: false }
  - path: "/"
    upstreams: ["fast"]
    cache: { enabled: false }
rateLimit:
  enabled: false
cache:
  enabled: false
`;
  fs.writeFileSync(tmpConfig, configYaml, "utf8");

  const proxyLogPath = path.join(os.tmpdir(), `ninja-chaos-proxy-${process.pid}.log`);
  const logFd = fs.openSync(proxyLogPath, "a");
  const proxy = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", tmpConfig], {
    cwd: REPO_ROOT,
    stdio: ["ignore", logFd, logFd],
  });

  async function waitListening(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const connected = await new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
          s.destroy();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      if (connected) return true;
      await sleep(200);
    }
    return false;
  }

  await waitListening(20000);
  await sleep(1000);

  try {
    await testClientAbortLeak(proxyPort, adminToken);
    await testWebSocketErrorHandling(proxyPort, proxy);
    await testJsonParseCrashTraps(proxyPort, proxy);
  } finally {
    await killProcessTree(proxy);
    await Promise.all([
      new Promise((resolve) => abortBackend.close(resolve)),
      new Promise((resolve) => fastBackend.close(resolve)),
      new Promise((resolve) => wsBackend.close(resolve)),
    ]);
    try {
      fs.unlinkSync(tmpConfig);
    } catch {}
    try {
      fs.unlinkSync(proxyLogPath);
    } catch {}
  }

  await testGracefulShutdown();

  console.log("\n================================================================================");
  console.log("  CHAOS RESILIENCE SUITE — RESULTS");
  console.log("================================================================================\n");
  const sections = [...new Set(results.map((r) => r.section))];
  for (const section of sections) {
    const rows = results.filter((r) => r.section === section);
    const passed = rows.filter((r) => r.passed).length;
    console.log(`${passed === rows.length ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m"} ${section} (${passed}/${rows.length})`);
  }
  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`\nTOTAL: ${totalPassed}/${results.length} assertions passed`);
  process.exitCode = totalPassed === results.length ? 0 : 1;
}

// Guards against an external signal, an uncaught exception, or a hang skipping every
// section's own per-section cleanup. Each section's spawned proxy is local to that section
// (no shared module-level reference), but every one of their tmp config paths is tagged with
// this exact process's own pid (ninja-chaos*-${process.pid}.yaml), so a pkill matched on that
// pid-tagged pattern is a safe, specific way to reach them without touching any other
// process on the machine.
const CHAOS_PROXY_PATTERN = `dist/index\\.js.*ninja-chaos.*-${process.pid}\\.yaml`;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
let hardTimeoutTimer = setTimeout(() => {
  console.error(`[chaos-suite] FATAL: hard timeout exceeded (${HARD_TIMEOUT_MS}ms) — forcing cleanup and exit`);
  forceCleanupAndExit(1);
}, HARD_TIMEOUT_MS);
function forceCleanupAndExit(code) {
  clearTimeout(hardTimeoutTimer);
  try { execSync(`pkill -9 -f "${CHAOS_PROXY_PATTERN}"`, { stdio: "ignore" }); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => { console.error("[chaos-suite] FATAL: received SIGINT"); forceCleanupAndExit(130); });
process.on("SIGTERM", () => { console.error("[chaos-suite] FATAL: received SIGTERM"); forceCleanupAndExit(143); });
process.on("uncaughtException", (err) => { console.error(`[chaos-suite] FATAL: uncaughtException: ${err?.stack || err}`); forceCleanupAndExit(1); });
process.on("unhandledRejection", (reason) => { console.error(`[chaos-suite] FATAL: unhandledRejection: ${reason?.stack || reason}`); forceCleanupAndExit(1); });

main()
  .then(() => clearTimeout(hardTimeoutTimer))
  .catch((err) => {
    console.error("[chaos-suite] FATAL:", err.stack || err.message);
    process.exitCode = 1;
    clearTimeout(hardTimeoutTimer);
  });
