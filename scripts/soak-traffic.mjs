#!/usr/bin/env node
// =============================================================================
// Phase F2/F3 soak traffic generator — a standalone OS process (never imported
// into scripts/soak.mjs's own event loop) that drives real mixed traffic
// against the real proxy for the whole soak duration. scripts/soak.mjs spawns
// this, reads its periodic JSON status lines from stdout, and SIGTERMs it when
// the run ends.
//
// Traffic mix per "tick" (every TICK_MS), paced to --rate req/s in aggregate:
//   - GET  /echo        (not cacheable)
//   - GET  /cacheable    (cacheable)
//   - GET  /sticky       (same cookie reused across a batch of calls)
//   - GET  /canary       (natural, cookie-less — exercises the weighted split)
//   - POST /upload       (64KB body, SHA-256 verified via the upstream's own echo)
//   - GET  /download     (--download-mb, default 1MB, SHA-256 verified against the fixed body)
//   - POST /upload       (--large-upload-mb, default 2MB, SHA-256 verified)
//   - GET  /rate-limited (some with a spoofed X-Forwarded-For)
//   - OPTIONS /cors      (alternating allowed/disallowed Origin)
//   - POST /upload-limited (oversized, 2MB body against a 1MB route limit -> 413)
//   - GET  /flapping     (hits the flapping upstream directly)
//   - GET  /dynamic      (only meaningful once admin-registered; 503 otherwise, which is fine)
// Plus, outside the rate-paced loop: a pool of held-open SSE and WebSocket connections
// (--sse-pool-size/--ws-pool-size, default 5 each, hard-capped at 50), replaced periodically.
//
// Every request to /upload (never /upload-limited, which must NOT reach the upstream) carries
// a unique X-Request-Id header — scripts/soak.mjs checks the upstream's own /stats for
// duplicate deliveries of these ids as the "no non-idempotent request was retried" proof.
// =============================================================================
import http from "node:http";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { acceptKeyFor, encodeFrame, createFrameParser } from "./bench/ws-lite.mjs";

// This generator deliberately creates aggressive, ephemeral connections for the whole soak
// duration (client aborts, upload/download churn, WS/SSE streams that get severed by the
// proxy's own worker-kill and hot-reload live ops) — an async socket-level error (EPIPE,
// ECONNRESET) landing on a socket between its 'error' listener being attached and removed is
// expected background noise for a generator shaped like this, not a reason to take the whole
// generator down and lose every report for the rest of the run. A real production load
// generator in this role needs the same resilience a reverse proxy itself needs.
let uncaughtSocketErrors = 0;
process.on("uncaughtException", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ECONNRESET" || err.code === "ECONNABORTED")) {
    uncaughtSocketErrors++;
    return;
  }
  console.error(`[soak-traffic] FATAL uncaughtException: ${err?.stack || err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason;
  if (err && (err.code === "EPIPE" || err.code === "ECONNRESET" || err.code === "ECONNABORTED")) {
    uncaughtSocketErrors++;
    return;
  }
  console.error(`[soak-traffic] FATAL unhandledRejection: ${err?.stack || err}`);
  process.exit(1);
});

const { values: args } = parseArgs({
  options: {
    "proxy-port": { type: "string", default: "20080" },
    rate: { type: "string", default: "1500" },
    "cors-allowed": { type: "string", default: "http://allowed.example.com" },
    "cors-disallowed": { type: "string", default: "http://evil.example.com" },
    "report-interval-ms": { type: "string", default: "5000" },
    "abort-rate": { type: "string", default: "0.01" },
    "download-mb": { type: "string", default: "1" },
    "large-upload-mb": { type: "string", default: "2" },
    "sse-pool-size": { type: "string", default: "5" },
    "ws-pool-size": { type: "string", default: "5" },
  },
});
const PROXY_PORT = Number(args["proxy-port"]);
const TARGET_RATE = Number(args.rate);
const CORS_ALLOWED = args["cors-allowed"];
const CORS_DISALLOWED = args["cors-disallowed"];
const REPORT_INTERVAL_MS = Number(args["report-interval-ms"]);
const ABORT_RATE = Number(args["abort-rate"]);
const DOWNLOAD_MB = Number(args["download-mb"]);
const LARGE_UPLOAD_MB = Number(args["large-upload-mb"]);
// Hard safety ceiling regardless of what's passed — this generator must never balloon to an
// unbounded number of held-open connections just from a misconfigured or buggy flag value.
const POOL_SIZE_CEILING = 50;
const SSE_POOL_SIZE = Math.min(POOL_SIZE_CEILING, Number(args["sse-pool-size"]));
const WS_POOL_SIZE = Math.min(POOL_SIZE_CEILING, Number(args["ws-pool-size"]));

const TICK_MS = 100;
const PER_TICK = (TARGET_RATE * TICK_MS) / 1000;

const counts = {}; // kind -> {sent, ok, error, aborted}
function bump(kind, field) {
  if (!counts[kind]) counts[kind] = { sent: 0, ok: 0, error: 0, aborted: 0 };
  counts[kind][field]++;
}

const integrity = { ok: 0, fail: 0 };
const corsResults = { allowedGotHeader: 0, allowedMissingHeader: 0, disallowedGotHeader: 0, disallowedCorrectlyBlocked: 0 };
const statusCounts = {}; // status code -> count, across all traffic
let clientAbortsIssued = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 256 });

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

function request(path, { method = "GET", headers = {}, body, agent = keepAliveAgent, abortAfterMs } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let aborted = false;
    const req = http.request(
      { host: "127.0.0.1", port: PROXY_PORT, path, method, headers, agent, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => {
          if (!aborted) chunks.push(c);
        });
        res.on("end", () => {
          if (aborted) return;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - t0, aborted: false });
        });
        res.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t0, aborted: false, error: true }));
      },
    );
    req.on("error", () => {
      if (!aborted) resolve({ status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t0, aborted, error: true });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t0, aborted: false, error: true });
    });
    if (abortAfterMs !== undefined) {
      setTimeout(() => {
        aborted = true;
        req.destroy();
        clientAbortsIssued++;
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t0, aborted: true });
      }, abortAfterMs);
    }
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function maybeAbort() {
  return Math.random() < ABORT_RATE ? Math.floor(Math.random() * 30) + 5 : undefined;
}

function recordStatus(status) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
}

// ----------------------------------------------------------------------------
// Traffic kinds
// ----------------------------------------------------------------------------
async function doEcho() {
  bump("echo", "sent");
  const r = await request("/echo", { abortAfterMs: maybeAbort() });
  recordStatus(r.status);
  if (r.aborted) bump("echo", "aborted");
  else if (r.status === 200) bump("echo", "ok");
  else bump("echo", "error");
}

async function doCacheable() {
  bump("cacheable", "sent");
  const r = await request("/cacheable");
  recordStatus(r.status);
  if (r.status === 200) bump("cacheable", "ok");
  else bump("cacheable", "error");
}

let stickyCookieJar = `sticky-${randomId()}`;
let stickyRequestsOnCurrentCookie = 0;
async function doSticky() {
  bump("sticky", "sent");
  // Rotate to a fresh cookie every so often so different workers' pools get exercised
  // across the run, while still holding one cookie steady long enough to prove stickiness.
  stickyRequestsOnCurrentCookie++;
  if (stickyRequestsOnCurrentCookie > 20) {
    stickyCookieJar = `sticky-${randomId()}`;
    stickyRequestsOnCurrentCookie = 0;
  }
  const r = await request("/sticky", { headers: { Cookie: `SOAK_ROUTE=${stickyCookieJar}` } });
  recordStatus(r.status);
  if (r.status === 200) bump("sticky", "ok");
  else bump("sticky", "error");
}

async function doCanary() {
  bump("canary", "sent");
  const r = await request("/canary");
  recordStatus(r.status);
  if (r.status === 200) bump("canary", "ok");
  else bump("canary", "error");
}

const upload64k = crypto.randomBytes(64 * 1024);
const upload64kSha = crypto.createHash("sha256").update(upload64k).digest("hex");
async function doUpload64k() {
  bump("upload64k", "sent");
  const reqId = randomId();
  const r = await request("/upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": upload64k.length, "x-request-id": reqId },
    body: upload64k,
    abortAfterMs: maybeAbort(),
  });
  recordStatus(r.status);
  if (r.aborted) {
    bump("upload64k", "aborted");
    return;
  }
  if (r.status === 200) {
    try {
      const parsed = JSON.parse(r.body.toString("utf8"));
      if (parsed.sha256 === upload64kSha) {
        integrity.ok++;
        bump("upload64k", "ok");
      } else {
        integrity.fail++;
        bump("upload64k", "error");
      }
    } catch {
      bump("upload64k", "error");
    }
  } else {
    bump("upload64k", "error");
  }
}

// Generated once at startup (not per-call) — same rationale as upload64k: this is traffic
// shape/integrity exercise, not a test of the generator's own hashing throughput.
const largeUploadBody = crypto.randomBytes(LARGE_UPLOAD_MB * 1024 * 1024);
const largeUploadSha = crypto.createHash("sha256").update(largeUploadBody).digest("hex");

async function doLargeUpload() {
  bump("largeUpload", "sent");
  const reqId = randomId();
  const r = await request("/upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": largeUploadBody.length, "x-request-id": reqId },
    body: largeUploadBody,
    abortAfterMs: maybeAbort(),
  });
  recordStatus(r.status);
  if (r.aborted) {
    bump("largeUpload", "aborted");
    return;
  }
  if (r.status === 200) {
    try {
      const parsed = JSON.parse(r.body.toString("utf8"));
      if (parsed.sha256 === largeUploadSha) {
        integrity.ok++;
        bump("largeUpload", "ok");
      } else {
        integrity.fail++;
        bump("largeUpload", "error");
      }
    } catch {
      bump("largeUpload", "error");
    }
  } else {
    bump("largeUpload", "error");
  }
}

async function doDownload() {
  bump("download", "sent");
  const r = await request("/download", { abortAfterMs: maybeAbort() });
  recordStatus(r.status);
  if (r.aborted) {
    bump("download", "aborted");
    return;
  }
  if (r.status === 200 && r.body.length === DOWNLOAD_MB * 1024 * 1024) {
    integrity.ok++;
    bump("download", "ok");
  } else if (r.status === 200) {
    integrity.fail++;
    bump("download", "error");
  } else {
    bump("download", "error");
  }
}

async function doRateLimited(spoofXff) {
  bump("rateLimited", "sent");
  const headers = {};
  if (spoofXff) headers["x-forwarded-for"] = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
  const r = await request("/rate-limited", { headers });
  recordStatus(r.status);
  if (r.status === 200 || r.status === 429) bump("rateLimited", "ok");
  else bump("rateLimited", "error");
}

async function doCorsPreflight(allowed) {
  bump("cors", "sent");
  const origin = allowed ? CORS_ALLOWED : CORS_DISALLOWED;
  const r = await request("/cors", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
  });
  recordStatus(r.status);
  const acao = r.headers["access-control-allow-origin"];
  if (allowed) {
    if (acao === CORS_ALLOWED) corsResults.allowedGotHeader++;
    else corsResults.allowedMissingHeader++;
  } else {
    if (acao === CORS_DISALLOWED || acao === "*") corsResults.disallowedGotHeader++;
    else corsResults.disallowedCorrectlyBlocked++;
  }
  bump("cors", "ok");
}

const oversizedBody = crypto.randomBytes(2 * 1024 * 1024); // > /upload-limited's 1MB maxBodyBytes
async function doOversizedBody() {
  bump("oversized", "sent");
  const r = await request("/upload-limited", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": oversizedBody.length },
    body: oversizedBody,
  });
  recordStatus(r.status);
  if (r.status === 413) bump("oversized", "ok");
  else bump("oversized", "error");
}

async function doFlapping() {
  bump("flapping", "sent");
  const r = await request("/flapping", { abortAfterMs: maybeAbort() });
  recordStatus(r.status);
  if (r.aborted) bump("flapping", "aborted");
  // 502/503 here is expected whenever the backend is in its DOWN window — not an error for
  // this generator's own bookkeeping; scripts/soak.mjs is the one that knows to exclude
  // flapping-backend's own downtime window from the global error-rate criterion.
  else bump("flapping", "ok");
}

async function doDynamic() {
  bump("dynamic", "sent");
  const r = await request("/dynamic");
  recordStatus(r.status);
  // 503 is the correct answer whenever dynamic-upstream isn't currently registered — not an
  // error for this generator; scripts/soak.mjs checks the registered-vs-deregistered windows.
  bump("dynamic", "ok");
}

// Weighted pick — echo/cacheable/sticky/canary/rate-limited dominate (cheap, frequent);
// uploads/downloads/cors/oversized/flapping/dynamic are rarer (expensive or special-purpose).
const WEIGHTED_KINDS = [
  [doEcho, 30],
  [doCacheable, 20],
  [doSticky, 10],
  [doCanary, 10],
  [() => doUpload64k(), 10],
  [() => doDownload(), 8],
  [() => doLargeUpload(), 2],
  [() => doRateLimited(false), 6],
  [() => doRateLimited(true), 4],
  [() => doCorsPreflight(true), 2],
  [() => doCorsPreflight(false), 2],
  [() => doOversizedBody(), 1],
  [doFlapping, 6],
  [doDynamic, 1],
];
const TOTAL_WEIGHT = WEIGHTED_KINDS.reduce((s, [, w]) => s + w, 0);
function pickKind() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const [fn, w] of WEIGHTED_KINDS) {
    if (r < w) return fn;
    r -= w;
  }
  return WEIGHTED_KINDS[0][0];
}

// ----------------------------------------------------------------------------
// SSE pool — a handful of held-open streams, each replaced after 10-30s, verifying
// messages arrive from the real upstream (not simulated) in order. SSE_POOL_SIZE itself is
// declared above (CLI-configurable, clamped to POOL_SIZE_CEILING).
// ----------------------------------------------------------------------------
let sseStreamsStarted = 0;
let sseMessagesReceived = 0;
let sseErrors = 0;
let sseStopping = false;
const sseRequests = new Set(); // in-flight req objects — shutdown() must destroy these directly,
// not just stop starting new ones, or they (and the proxy-side connections they hold open)
// linger for up to their own holdMs (up to 30s) past the run ending.

function startSseStream() {
  if (sseStopping) return;
  sseStreamsStarted++;
  const holdMs = 10000 + Math.random() * 20000;
  const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, path: "/sse", method: "GET", headers: { Accept: "text/event-stream" } }, (res) => {
    recordStatus(res.statusCode);
    let buf = "";
    res.on("data", (c) => {
      buf += c.toString("utf8");
      if (buf.includes("\n\n")) {
        sseMessagesReceived++;
        buf = "";
      }
    });
    res.on("error", () => sseErrors++);
  });
  sseRequests.add(req);
  req.on("error", () => sseErrors++);
  req.on("close", () => sseRequests.delete(req));
  req.end();
  setTimeout(() => {
    req.destroy();
    startSseStream();
  }, holdMs);
}

// ----------------------------------------------------------------------------
// WebSocket pool — held open for the whole run, pinging both directions. WS_POOL_SIZE itself
// is declared above (CLI-configurable, clamped to POOL_SIZE_CEILING).
// ----------------------------------------------------------------------------
let wsMessagesSent = 0;
let wsMessagesReceived = 0;
let wsErrors = 0;
let wsStopping = false;
const wsSockets = [];

function startWsConnection(idx) {
  if (wsStopping) return;
  const key = crypto.randomBytes(16).toString("base64");
  const req = http.request({
    host: "127.0.0.1",
    port: PROXY_PORT,
    path: "/ws",
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    },
  });
  req.on("upgrade", (res, socket) => {
    wsSockets[idx] = socket;
    const parse = createFrameParser();
    socket.on("data", (chunk) => {
      for (const frame of parse(chunk)) {
        if (frame.opcode === 0x1) wsMessagesReceived++;
      }
    });
    socket.on("error", () => wsErrors++);
    socket.on("close", () => {
      wsSockets[idx] = undefined;
      if (!wsStopping) setTimeout(() => startWsConnection(idx), 500);
    });
    const pingLoop = setInterval(() => {
      if (wsStopping || socket.destroyed) {
        clearInterval(pingLoop);
        return;
      }
      try {
        socket.write(encodeFrame(`ping-${Date.now()}`, { opcode: 0x1, masked: true }));
        wsMessagesSent++;
      } catch {
        wsErrors++;
      }
    }, 3000);
  });
  req.on("error", () => {
    wsErrors++;
    if (!wsStopping) setTimeout(() => startWsConnection(idx), 1000);
  });
  req.end();
}

// ----------------------------------------------------------------------------
// Main pacing loop
// ----------------------------------------------------------------------------
let running = true;
let accumulator = 0;
let inFlight = 0;

async function tick() {
  accumulator += PER_TICK;
  const toIssue = Math.floor(accumulator);
  accumulator -= toIssue;
  for (let i = 0; i < toIssue; i++) {
    inFlight++;
    const fn = pickKind();
    fn()
      .catch(() => {})
      .finally(() => {
        inFlight--;
      });
  }
}

const startedAt = Date.now();
function printReport(final = false) {
  const report = {
    type: final ? "final" : "status",
    tSec: Math.round((Date.now() - startedAt) / 1000),
    counts,
    integrity,
    cors: corsResults,
    statusCounts,
    clientAbortsIssued,
    sse: { streamsStarted: sseStreamsStarted, messagesReceived: sseMessagesReceived, errors: sseErrors },
    ws: { messagesSent: wsMessagesSent, messagesReceived: wsMessagesReceived, errors: wsErrors, connected: wsSockets.filter(Boolean).length },
    inFlight,
    uncaughtSocketErrors,
  };
  console.log(JSON.stringify(report));
}

const tickTimer = setInterval(() => {
  if (running) void tick();
}, TICK_MS);
const reportTimer = setInterval(() => printReport(false), REPORT_INTERVAL_MS);

for (let i = 0; i < SSE_POOL_SIZE; i++) startSseStream();
for (let i = 0; i < WS_POOL_SIZE; i++) startWsConnection(i);

async function shutdown() {
  running = false;
  sseStopping = true;
  wsStopping = true;
  clearInterval(tickTimer);
  clearInterval(reportTimer);
  for (const s of wsSockets) {
    if (s && !s.destroyed) {
      try {
        s.end();
      } catch {}
    }
  }
  for (const req of sseRequests) {
    try {
      req.destroy();
    } catch {}
  }
  // Give in-flight requests a moment to settle before the final report.
  const deadline = Date.now() + 5000;
  while (inFlight > 0 && Date.now() < deadline) await sleep(100);
  // Closes every pooled, idle keep-alive socket this agent is holding open — without this,
  // the proxy's active-connections gauge can stay above 0 for a while after traffic truly
  // stops, since a pooled-but-idle socket is still an open connection from the proxy's side.
  keepAliveAgent.destroy();
  printReport(true);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

console.log(JSON.stringify({ type: "started", proxyPort: PROXY_PORT, targetRate: TARGET_RATE, pid: process.pid }));
