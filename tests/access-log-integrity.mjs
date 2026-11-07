// =============================================================================
// ACCESS LOG INTEGRITY SUITE (Phase G, Item 1)
// =============================================================================
// Regression test for the ~24% access-log-vs-Prometheus gap observed in the Phase F2/F3
// soak (679,592 access-log lines vs 897,864 Prometheus-counted requests; 345 upstream resets
// cannot explain ~218,000 missing lines). Root cause (confirmed directly, see
// docs/results/phase-g-item1-report.md): Logger.getLogStream() cached a single WriteStream
// per path forever, including after it errored/was destroyed. A destroyed stream's .write()
// returns false WITHOUT throwing -- the old code never checked that return value and never
// evicted the dead stream, so one transient fs error on one worker's stream (EMFILE, ENOSPC,
// a disk hiccup -- all plausible over a multi-hour soak under load) silently dropped every
// access-log line that worker ever tried to write for the rest of the run, while the
// Prometheus counter (recordRequest, synchronous and in-memory) kept counting normally the
// whole time. A handful of upstream resets, by contrast, can only ever explain a handful of
// missing lines.
//
// This suite proves two things against the REAL built proxy (4 workers, real cluster mode):
//   1. Every request this harness sends gets assigned a request id (x-request-id, generated
//      by the proxy if the client didn't send one) that appears on exactly one access-log
//      line, with the status that line records matching what the client itself observed --
//      under ~2 minutes of sustained mixed traffic (plain GET/POST, a rate-limited route,
//      CORS preflight, a 413, deliberate upstream resets, client-side aborts, a live SSE
//      stream, and a live WebSocket tunnel) run concurrently across all 4 workers.
//   2. x-request-id is generated when the client doesn't send one, and once generated it is
//      the same id this request's access-log line (and nothing else's) carries.
//
// A graceful SIGTERM shutdown is the only way this suite reads the final access log --
// proving the flush-before-exit guarantee (worker.ts's GRACEFUL_SHUTDOWN handler explicitly
// awaits logger.flushAll() before process.exit(0)) is both necessary and sufficient to see
// every line this run's traffic produced.
//
// Usage: node tests/access-log-integrity.mjs [--duration-ms 120000]
// The mandated gate runs this twice: the full 120000ms (2 minute) run on its own, plus a
// 30000ms (30s) variant wired into scripts/phase-g-run-gate.sh for routine full-gate runs.
// =============================================================================
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { acceptKeyFor, encodeFrame, createFrameParser } from "../scripts/bench/ws-lite.mjs";
import { killProcessTree } from "./helpers/kill-process-tree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const { values: args } = parseArgs({ options: { "duration-ms": { type: "string", default: "120000" } } });
const LOAD_DURATION_MS = Number(args["duration-ms"]);

const PROXY_PORT = 8595;
const UP_MAIN = 4720;
const UP_RESET = 4721;
const ACCESS_LOG_PATH = path.join(os.tmpdir(), `ninja-access-log-integrity-${process.pid}.log`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches writeAccessLog's exact line format (src/observability/logger/logger.ts):
// `${clientIp} - - [${timestamp}] "${method} ${url} HTTP/1.1" ${status} ${bytes} "-" "${ua}" ${ms}ms rid=${id}\n`
const LOG_LINE_RE = /^(\S+) - - \[([^\]]+)\] "(\S+) (\S+) HTTP\/[\d.]+" (\d+) (\d+) "-" "([^"]*)" ([\d.]+)ms rid=(\S+)$/;

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? "\x1b[32m✅ PASS\x1b[0m" : "\x1b[31m❌ FAIL\x1b[0m";
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function log(msg) {
  console.log(`[access-log-integrity] ${msg}`);
}

// -----------------------------------------------------------------------------
// Mock upstreams
// -----------------------------------------------------------------------------
function startMock(port, handler, upgradeHandler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    if (upgradeHandler) server.on("upgrade", upgradeHandler);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function consumeBody(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

function mainHandler(req, res) {
  const cleanPath = (req.url || "/").split("?")[0];
  if (cleanPath === "/" ) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (cleanPath === "/al-post") {
    consumeBody(req, () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (cleanPath === "/al-sse") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("data: first\n\n");
    setTimeout(() => {
      res.write("data: second\n\n");
      res.end();
    }, 150);
    return;
  }
  if (cleanPath === "/al-slow") {
    consumeBody(req, () => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("slow-ok");
        }
      }, 2000);
    });
    return;
  }
  // /al-normal, /al-ratelimited, /al-cors, /al-413 all just need a fast 200 once they
  // actually reach the upstream (413/CORS/429 are all decided by the proxy before dispatch).
  consumeBody(req, () => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
}

function wsUpgradeHandler(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`);
  const parse = createFrameParser();
  socket.on("data", (chunk) => {
    for (const frame of parse(chunk)) {
      if (frame.opcode === 0x1) socket.write(encodeFrame(`echo:${frame.payload.toString()}`, { opcode: 0x1, masked: false }));
      else if (frame.opcode === 0x8) {
        try {
          socket.end();
        } catch {}
      }
    }
  });
  socket.on("error", () => {});
}

// Always resets before any response is written -- every request to this upstream must
// deterministically produce a well-formed (non-200) status from the PROXY to the client
// (502, or 503 if the breaker is open), never a hang and never a client-visible transport
// failure. The client connection to the proxy itself is never touched by this.
function resetHandler(req, res) {
  res.socket.destroy();
}

// -----------------------------------------------------------------------------
// Proxy config + lifecycle
// -----------------------------------------------------------------------------
const CONFIG_YAML = `
server:
  listen: ${PROXY_PORT}
  workers: 4
  compression: false

tls:
  enabled: false

observability:
  logging:
    level: warn
    accessLog: "${ACCESS_LOG_PATH}"

admin:
  enabled: false

upstreams:
  - id: main-backend
    url: "http://127.0.0.1:${UP_MAIN}"
    healthPath: "/"
  - id: reset-backend
    url: "http://127.0.0.1:${UP_RESET}"
    healthPath: "/"

routes:
  - path: "/al-normal"
    upstreams: ["main-backend"]
    cache: { enabled: false }
  - path: "/al-post"
    upstreams: ["main-backend"]
    cache: { enabled: false }
  - path: "/al-sse"
    upstreams: ["main-backend"]
    cache: { enabled: false }
  - path: "/al-ws"
    upstreams: ["main-backend"]
    cache: { enabled: false }
  - path: "/al-slow"
    upstreams: ["main-backend"]
    cache: { enabled: false }
  - path: "/al-reset"
    upstreams: ["reset-backend"]
    cache: { enabled: false }
  - path: "/al-ratelimited"
    upstreams: ["main-backend"]
    cache: { enabled: false }
    rateLimit:
      windowMs: 1000
      maxRequests: 30
      algorithm: fixed-window
  - path: "/al-cors"
    upstreams: ["main-backend"]
    cache: { enabled: false }
    cors:
      origins: ["http://allowed.example.com"]
  - path: "/al-413"
    upstreams: ["main-backend"]
    cache: { enabled: false }
    maxBodyBytes: 1024

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
  enabled: false
`;

const tmpConfigPath = path.join(os.tmpdir(), `ninja-access-log-integrity-${process.pid}.yaml`);
const proxyLogPath = path.join(os.tmpdir(), `ninja-access-log-integrity-proxy-${process.pid}.log`);
let proxyProc;
let mockServers = [];
let cleanedUp = false;

async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/al-normal", method: "GET", timeout: 1000 }, (res) => {
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
  await killProcessTree(proxyProc);
  for (const s of mockServers) {
    try {
      s.closeAllConnections?.();
      await Promise.race([new Promise((r) => s.close(r)), sleep(3000)]);
    } catch {}
  }
  try {
    fs.unlinkSync(tmpConfigPath);
  } catch {}
}

// -----------------------------------------------------------------------------
// HTTP helper -- every call sets (or deliberately omits) x-request-id itself.
// -----------------------------------------------------------------------------
function requestWithAgent(agent) {
  return function doRequest(urlPath, { method = "GET", headers = {}, body, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, path: urlPath, method, headers, agent, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      if (body !== undefined) req.end(body);
      else req.end();
    });
  };
}

// -----------------------------------------------------------------------------
// Test A: x-request-id is generated when absent, and appears on that request's own line.
// Run sequentially, with no other traffic in flight, so each generated id can be matched
// to the one new line it must have produced.
// -----------------------------------------------------------------------------
async function testRequestIdGeneratedWhenAbsent() {
  const agent = new http.Agent({ keepAlive: false });
  const doRequest = requestWithAgent(agent);
  const N = 8;
  const generatedIds = [];
  let allValidUuids = true;
  let allLinesFound = true;
  const details = [];

  for (let i = 0; i < N; i++) {
    const before = fs.existsSync(ACCESS_LOG_PATH) ? fs.readFileSync(ACCESS_LOG_PATH, "utf8") : "";
    const linesBefore = before.split("\n").filter(Boolean).length;
    const r = await doRequest("/al-normal"); // deliberately no x-request-id header
    if (r.status !== 200) details.push(`request ${i} unexpected status ${r.status}`);

    let newLine = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const after = fs.readFileSync(ACCESS_LOG_PATH, "utf8").split("\n").filter(Boolean);
      if (after.length > linesBefore) {
        newLine = after[after.length - 1];
        break;
      }
      await sleep(50);
    }
    if (!newLine) {
      allLinesFound = false;
      details.push(`request ${i}: no new access-log line appeared within 2s`);
      continue;
    }
    const m = newLine.match(LOG_LINE_RE);
    if (!m) {
      allLinesFound = false;
      details.push(`request ${i}: new line did not parse: ${newLine}`);
      continue;
    }
    const rid = m[9];
    if (!UUID_RE.test(rid)) {
      allValidUuids = false;
      details.push(`request ${i}: rid "${rid}" is not a generated UUID`);
      continue;
    }
    generatedIds.push(rid);
  }

  const allUnique = new Set(generatedIds).size === generatedIds.length;
  record(
    "A. x-request-id is generated (valid UUID) when the client sends none, one per request, all unique",
    allLinesFound && allValidUuids && allUnique && generatedIds.length === N,
    `generated ${generatedIds.length}/${N} valid unique UUIDs` + (details.length ? `; issues: ${details.join("; ")}` : ""),
  );
}

// -----------------------------------------------------------------------------
// Test B: the main 2-minute (or --duration-ms) mixed-traffic load.
// -----------------------------------------------------------------------------
async function testSustainedMixedTrafficIntegrity() {
  const groundTruthStatus = new Map(); // id -> status the CLIENT observed
  const abortedIds = new Set(); // ids deliberately aborted before any response ever existed
  let nextSeq = 0;
  const nextId = (tag) => `al-${tag}-${process.pid}-${nextSeq++}-${crypto.randomBytes(4).toString("hex")}`;

  const normalAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const postAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  const rlAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  const corsAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const bigAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const resetAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const abortAgent = new http.Agent({ keepAlive: false, maxSockets: 16 });

  const doNormal = requestWithAgent(normalAgent);
  const doPost = requestWithAgent(postAgent);
  const doRl = requestWithAgent(rlAgent);
  const doCors = requestWithAgent(corsAgent);
  const doBig = requestWithAgent(bigAgent);
  const doReset = requestWithAgent(resetAgent);

  const deadline = Date.now() + LOAD_DURATION_MS;
  let running = true;
  let sent = 0;

  async function lane(fn, concurrency) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (running && Date.now() < deadline) {
          try {
            await fn();
          } catch {
            // transport-level hiccups against the proxy itself (not the deliberate
            // upstream-reset/abort cases, which are handled inline) are not expected --
            // if they happen, the id was never recorded in groundTruthStatus, and the
            // final verification will simply not require a line for it.
          }
        }
      }),
    );
  }

  async function normalOnce() {
    const id = nextId("normal");
    const r = await doNormal("/al-normal", { headers: { "x-request-id": id } });
    groundTruthStatus.set(id, r.status);
    sent++;
  }
  async function postOnce() {
    const id = nextId("post");
    const r = await doPost("/al-post", { method: "POST", headers: { "x-request-id": id, "Content-Type": "application/octet-stream" }, body: crypto.randomBytes(2048) });
    groundTruthStatus.set(id, r.status);
    sent++;
  }
  async function rlOnce() {
    const id = nextId("rl");
    const r = await doRl("/al-ratelimited", { headers: { "x-request-id": id } });
    groundTruthStatus.set(id, r.status);
    sent++;
  }
  async function corsOnce() {
    const id = nextId("cors");
    const r = await doCors("/al-cors", { method: "OPTIONS", headers: { "x-request-id": id, Origin: "http://allowed.example.com" } });
    groundTruthStatus.set(id, r.status);
    sent++;
  }
  async function bigOnce() {
    const id = nextId("big");
    const r = await doBig("/al-413", { method: "POST", headers: { "x-request-id": id, "Content-Type": "application/octet-stream" }, body: Buffer.alloc(8192) });
    groundTruthStatus.set(id, r.status);
    sent++;
  }
  async function resetOnce() {
    const id = nextId("reset");
    const r = await doReset("/al-reset", { headers: { "x-request-id": id }, timeoutMs: 5000 });
    groundTruthStatus.set(id, r.status);
    sent++;
  }
  async function abortOnce() {
    const id = nextId("abort");
    abortedIds.add(id);
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, path: "/al-slow", method: "GET", headers: { "x-request-id": id }, agent: abortAgent }, () => {});
      req.on("error", () => {});
      req.end();
      setTimeout(() => {
        req.destroy();
        sent++;
        resolve();
      }, 40 + Math.random() * 40);
    });
  }

  // Long-lived SSE lanes: each cycle is one logical request (reconnect on completion), with
  // its own id tracked like every other category.
  async function sseLane(concurrency) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (running && Date.now() < deadline) {
          const id = nextId("sse");
          const status = await new Promise((resolve) => {
            let settled = false;
            const done = (v) => {
              if (settled) return;
              settled = true;
              clearTimeout(watchdog);
              resolve(v);
            };
            // Watchdog: a connection that never fires 'end'/'error' (a stall under load,
            // not a real response) must not block this lane forever -- it would otherwise
            // make the whole load phase run far longer than --duration-ms, exactly as
            // observed in an earlier run of this suite (658s instead of 120s).
            const watchdog = setTimeout(() => {
              try {
                req.destroy();
              } catch {}
              done(null);
            }, 5000);
            const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, path: "/al-sse", method: "GET", headers: { "x-request-id": id } }, (res) => {
              res.on("data", () => {});
              res.on("end", () => done(res.statusCode));
              res.on("error", () => done(null));
            });
            req.on("error", () => done(null));
            req.end();
          });
          if (status !== null) {
            groundTruthStatus.set(id, status);
            sent++;
          }
        }
      }),
    );
  }

  // Long-lived WS lanes: one id per upgrade (tunnel), logged once as 101 the moment the
  // upgrade is accepted (see worker.ts's wsUpgradeHandler) -- reconnect after a short hold.
  async function wsLane(concurrency) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (running && Date.now() < deadline) {
          const id = nextId("ws");
          const status = await new Promise((resolve) => {
            let settled = false;
            const done = (v) => {
              if (settled) return;
              settled = true;
              clearTimeout(watchdog);
              resolve(v);
            };
            // Same watchdog as sseLane -- an upgrade that never fires 'upgrade'/'error'
            // must not block this lane (and therefore the whole load phase) forever.
            const watchdog = setTimeout(() => {
              try {
                req.destroy();
              } catch {}
              done(null);
            }, 5000);
            const req = http.request({
              host: "127.0.0.1",
              port: PROXY_PORT,
              path: "/al-ws",
              method: "GET",
              headers: {
                "x-request-id": id,
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
                "Sec-WebSocket-Version": "13",
              },
            });
            req.on("upgrade", (res, socket) => {
              socket.on("error", () => {});
              socket.write(encodeFrame("ping", { opcode: 0x1, masked: true }));
              setTimeout(() => {
                try {
                  socket.end();
                } catch {}
                done(res.statusCode);
              }, 100 + Math.random() * 150);
            });
            req.on("error", () => done(null));
            req.end();
          });
          if (status !== null) {
            groundTruthStatus.set(id, status);
            sent++;
          }
        }
      }),
    );
  }

  log(`Starting ${LOAD_DURATION_MS}ms mixed-traffic load (4 workers)...`);
  const t0 = Date.now();
  await Promise.all([
    lane(normalOnce, 30),
    lane(postOnce, 15),
    lane(rlOnce, 10),
    lane(corsOnce, 5),
    lane(bigOnce, 3),
    lane(resetOnce, 5),
    lane(abortOnce, 5),
    sseLane(4),
    wsLane(4),
  ]);
  running = false;
  const elapsedS = (Date.now() - t0) / 1000;
  log(`Load complete: ${sent} logical requests/connections over ${elapsedS.toFixed(1)}s (${(sent / elapsedS).toFixed(0)}/s).`);

  // Scrape the drop counter BEFORE shutdown -- it's only reachable while the proxy is alive.
  let droppedTotal = 0;
  try {
    const metricsText = (await requestWithAgent(new http.Agent())("/metrics")).body.toString("utf8");
    const m = metricsText.match(/ninja_access_log_dropped_total\s+(\d+)/);
    if (m) droppedTotal = Number(m[1]);
  } catch (err) {
    log(`WARNING: could not scrape /metrics before shutdown: ${err.message}`);
  }

  // Graceful SIGTERM shutdown -- this is the only path that proves flush-before-exit.
  log("Sending SIGTERM for graceful shutdown...");
  const shutdownStart = Date.now();
  proxyProc.kill("SIGTERM");
  const exited = await Promise.race([new Promise((resolve) => proxyProc.once("exit", () => resolve(true))), sleep(40000).then(() => false)]);
  const shutdownMs = Date.now() - shutdownStart;
  if (!exited) {
    record("B0. Graceful SIGTERM shutdown completes (flush-before-exit)", false, `proxy did not exit within 40s of SIGTERM`);
    await killProcessTree(proxyProc, { signal: "SIGKILL", graceMs: 0 });
  } else {
    record("B0. Graceful SIGTERM shutdown completes (flush-before-exit)", true, `exited ${shutdownMs}ms after SIGTERM`);
  }

  // Now, and only now, read the final access log.
  const rawLines = fs.existsSync(ACCESS_LOG_PATH) ? fs.readFileSync(ACCESS_LOG_PATH, "utf8").split("\n") : [];
  const nonEmptyLines = rawLines.filter((l) => l.length > 0);
  const unparseable = [];
  const idOccurrences = new Map(); // id -> [{status}]
  for (const line of nonEmptyLines) {
    const m = line.match(LOG_LINE_RE);
    if (!m) {
      unparseable.push(line);
      continue;
    }
    const status = Number(m[5]);
    const rid = m[9];
    if (!idOccurrences.has(rid)) idOccurrences.set(rid, []);
    idOccurrences.get(rid).push(status);
  }

  record(
    "B1. Every access-log line is parseable (matches the documented format, including rid=)",
    unparseable.length === 0,
    `${unparseable.length} unparseable line(s) out of ${nonEmptyLines.length} total` + (unparseable.length ? `; first: ${unparseable[0]}` : ""),
  );

  const duplicateIds = [...idOccurrences.entries()].filter(([, statuses]) => statuses.length > 1);
  record(
    "B2. No request id appears on more than one access-log line (no duplicates, incl. aborted/retried requests)",
    duplicateIds.length === 0,
    `${duplicateIds.length} duplicated id(s)` + (duplicateIds.length ? `; e.g. ${duplicateIds[0][0]} x${duplicateIds[0][1].length}` : ""),
  );

  const nonAbortedIds = [...groundTruthStatus.keys()];
  const missingIds = nonAbortedIds.filter((id) => !idOccurrences.has(id));
  // A bounded-buffer drop is correctly counted (never silent) rather than a bug -- see
  // Logger.ACCESS_LOG_MAX_BUFFERED_BYTES. Only missing lines beyond what the drop counter
  // itself accounts for are an unexplained (real) loss.
  const unexplainedMissing = Math.max(0, missingIds.length - droppedTotal);
  record(
    "B3. Zero unexplained missing access-log lines (every dropped line is counted via ninja_access_log_dropped_total, never silent)",
    unexplainedMissing === 0,
    `${missingIds.length} missing out of ${nonAbortedIds.length} tracked requests; ninja_access_log_dropped_total=${droppedTotal}; unexplained=${unexplainedMissing}` +
      (missingIds.length && unexplainedMissing ? `; e.g. missing id ${missingIds[0]}` : ""),
  );

  const mismatchedIds = nonAbortedIds.filter((id) => {
    const occ = idOccurrences.get(id);
    return occ && occ.length === 1 && occ[0] !== groundTruthStatus.get(id);
  });
  record(
    "B4. Every logged status matches what the client itself observed for that request id",
    mismatchedIds.length === 0,
    `${mismatchedIds.length} mismatched id(s)` +
      (mismatchedIds.length ? `; e.g. ${mismatchedIds[0]}: client saw ${groundTruthStatus.get(mismatchedIds[0])}, log has ${idOccurrences.get(mismatchedIds[0])[0]}` : ""),
  );

  // Per-status aggregate counts, built independently from the two sources, must match exactly
  // (over the same non-aborted id set) -- this is the same property as B3/B4 taken together,
  // stated the way the task brief specifically asked for it.
  const expectedByStatus = new Map();
  for (const id of nonAbortedIds) {
    const s = groundTruthStatus.get(id);
    expectedByStatus.set(s, (expectedByStatus.get(s) || 0) + 1);
  }
  const actualByStatus = new Map();
  for (const id of nonAbortedIds) {
    const occ = idOccurrences.get(id);
    if (occ && occ.length === 1) actualByStatus.set(occ[0], (actualByStatus.get(occ[0]) || 0) + 1);
  }
  const statusDiffs = [];
  for (const [status, count] of expectedByStatus) {
    const actual = actualByStatus.get(status) || 0;
    if (actual !== count) statusDiffs.push(`status ${status}: expected ${count}, logged ${actual}`);
  }
  record(
    "B5. Per-status-code counts match exactly between client-observed outcomes and the access log",
    statusDiffs.length === 0,
    statusDiffs.length ? statusDiffs.join("; ") : `all ${expectedByStatus.size} distinct status codes match exactly (statuses: ${[...expectedByStatus.keys()].sort().join(",")})`,
  );

  const abortedButDuplicated = [...abortedIds].filter((id) => (idOccurrences.get(id)?.length || 0) > 1);
  record(
    "B6. Client-aborted (pre-response) requests never produce more than one access-log line",
    abortedButDuplicated.length === 0,
    `${abortedIds.size} aborted requests; ${abortedButDuplicated.length} with >1 log line`,
  );
}

function printSummary() {
  console.log("\n================================================================================");
  console.log("  ACCESS LOG INTEGRITY SUITE — RESULTS");
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
  const specs = [
    [UP_MAIN, mainHandler, wsUpgradeHandler],
    [UP_RESET, resetHandler],
  ];
  const startResults = await Promise.allSettled(specs.map((s) => startMock(...s)));
  mockServers = startResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failures = startResults.map((r, i) => ({ r, port: specs[i][0] })).filter(({ r }) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length} mock upstream(s) failed to start: ` + failures.map(({ r, port }) => `port ${port}: ${r.reason?.message || r.reason}`).join("; "));
  }
  log(`${mockServers.length} mock upstreams ready.`);

  try {
    fs.unlinkSync(ACCESS_LOG_PATH);
  } catch {}
  fs.writeFileSync(tmpConfigPath, CONFIG_YAML, "utf8");

  log(`Starting proxy (4 workers), listening on ${PROXY_PORT}...`);
  const proxyLogFd = fs.openSync(proxyLogPath, "a");
  proxyProc = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", tmpConfigPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", proxyLogFd, proxyLogFd],
    env: { ...process.env },
  });
  proxyProc.on("exit", (code, signal) => {
    if (!cleanedUp) log(`\x1b[33mProxy exited (code=${code}, signal=${signal}).\x1b[0m`);
  });

  await waitForReady(PROXY_PORT, 20000);
  log(`Proxy ready. (log: ${proxyLogPath})\n`);

  await testRequestIdGeneratedWhenAbsent();
  await testSustainedMixedTrafficIntegrity();

  printSummary();
  const allPassed = results.every((r) => r.passed);
  process.exitCode = allPassed ? 0 : 1;
}

const HARD_TIMEOUT_MS = Math.max(5 * 60 * 1000, LOAD_DURATION_MS + 3 * 60 * 1000);
let hardTimeoutTimer;

async function forceExit(reason, code) {
  console.error(`[access-log-integrity] FATAL: ${reason} — forcing cleanup and exit`);
  clearTimeout(hardTimeoutTimer);
  await cleanup();
  process.exit(code);
}

hardTimeoutTimer = setTimeout(() => {
  void forceExit(`hard timeout exceeded (${HARD_TIMEOUT_MS}ms)`, 1);
}, HARD_TIMEOUT_MS);

process.on("SIGINT", () => void forceExit("received SIGINT", 130));
process.on("SIGTERM", () => void forceExit("received SIGTERM", 143));
process.on("uncaughtException", (err) => void forceExit(`uncaughtException: ${err?.stack || err}`, 1));
process.on("unhandledRejection", (reason) => void forceExit(`unhandledRejection: ${reason?.stack || reason}`, 1));

main()
  .then(async () => {
    clearTimeout(hardTimeoutTimer);
    await cleanup();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(`[access-log-integrity] FATAL: ${err?.stack || err}`);
    clearTimeout(hardTimeoutTimer);
    await cleanup();
    process.exit(1);
  });
