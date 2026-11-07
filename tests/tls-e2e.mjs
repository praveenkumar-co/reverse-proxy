// =============================================================================
// TLS / HTTPS E2E SUITE (Phase G, Item 2)
// =============================================================================
// TLS/HTTPS had no end-to-end coverage before this suite. Exercises every real
// server.tls option that actually exists in src/config/schemas/server.schema.ts
// (confirmed by reading the schema and worker.ts's bootstrap before writing this):
//   tls.enabled, tls.cert, tls.key, tls.redirectHttp, tls.httpsPort, plus the legacy
//   server.sslKeyPath/server.sslCertPath fallback. There is no minVersion, ciphers, or
//   cert-reload option in this codebase -- none of those are tested here because they
//   don't exist, not because they were skipped.
//
// A fresh self-signed CA + leaf certificate is generated via openssl into os.tmpdir() at
// test run time (never committed) for every scenario.
//
// Two real bugs were found and fixed while building this suite (both in src/, see the
// commit this suite ships with):
//   1. X-Forwarded-Proto was derived from whether the PROXY-TO-UPSTREAM hop was HTTPS,
//      not whether the CLIENT's own connection to the proxy was -- backwards for the
//      overwhelmingly common deployment (HTTPS edge, plain-HTTP internal upstream),
//      which would always report "http" even for a fully TLS-terminated client request.
//   2. master.ts respawned a crashed worker unconditionally, with no backoff -- a bad/
//      missing TLS certificate crashes every worker instantly at startup, which would
//      have spun forever (100% CPU, no bound listener, no clear operator signal) instead
//      of failing fast. A crash-loop guard now exits the master after enough consecutive
//      near-instant worker deaths.
//
// Usage: node tests/tls-e2e.mjs
// =============================================================================
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { acceptKeyFor, encodeFrame, createFrameParser } from "../scripts/bench/ws-lite.mjs";
import { killProcessTree } from "./helpers/kill-process-tree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? "\x1b[32m✅ PASS\x1b[0m" : "\x1b[31m❌ FAIL\x1b[0m";
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function log(msg) {
  console.log(`[tls-e2e] ${msg}`);
}

// -----------------------------------------------------------------------------
// Certificate generation (self-signed CA + leaf, never committed)
// -----------------------------------------------------------------------------
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "ninja-tls-e2e-certs-"));
function genCerts() {
  const sh = (cmd) => execSync(cmd, { cwd: certDir, stdio: ["ignore", "ignore", "pipe"] });
  sh(`openssl genrsa -out ca-key.pem 2048`);
  sh(`openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 2 -out ca-cert.pem -subj "/CN=Phase G Test CA"`);
  sh(`openssl genrsa -out server-key.pem 2048`);
  sh(`openssl req -new -key server-key.pem -out server.csr -subj "/CN=127.0.0.1"`);
  fs.writeFileSync(path.join(certDir, "server-ext.cnf"), "[ v3 ]\nsubjectAltName = IP:127.0.0.1\nextendedKeyUsage = serverAuth\n");
  sh(`openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -days 2 -sha256 -extfile server-ext.cnf -extensions v3`);
  return {
    caCertPath: path.join(certDir, "ca-cert.pem"),
    serverCertPath: path.join(certDir, "server-cert.pem"),
    serverKeyPath: path.join(certDir, "server-key.pem"),
    caCertPem: fs.readFileSync(path.join(certDir, "ca-cert.pem")),
  };
}
let certs;

// -----------------------------------------------------------------------------
// Mock upstream (plain HTTP -- the common "HTTPS edge, plain-HTTP internal upstream"
// deployment shape) shared by every scenario that needs real traffic.
// -----------------------------------------------------------------------------
const UP_PORT = 4730;
const DOWNLOAD_SIZE = 20 * 1024 * 1024;
const downloadPayload = crypto.randomBytes(DOWNLOAD_SIZE);
const downloadSha = crypto.createHash("sha256").update(downloadPayload).digest("hex");

function startUpstream() {
  const server = http.createServer((req, res) => {
    const cleanPath = (req.url || "/").split("?")[0];
    if (cleanPath === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (cleanPath === "/tls-echo") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ xfp: req.headers["x-forwarded-proto"] ?? null }));
      return;
    }
    if (cleanPath === "/tls-upload") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const sha = crypto.createHash("sha256").update(body).digest("hex");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ bytes: body.length, sha256: sha }));
      });
      return;
    }
    if (cleanPath === "/tls-download") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": downloadPayload.length });
      res.end(downloadPayload);
      return;
    }
    if (cleanPath === "/tls-sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 100);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.on("upgrade", (req, socket) => {
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
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(UP_PORT, "127.0.0.1", () => resolve(server));
  });
}

// -----------------------------------------------------------------------------
// Proxy lifecycle helper -- one scenario at a time, fully torn down before the next.
// -----------------------------------------------------------------------------
async function waitForHttpsReady(port, caCertPem, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = https.request({ host: "127.0.0.1", port, path: "/tls-echo", method: "GET", ca: caCertPem, timeout: 1500 }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      });
      req.on("error", (err) => {
        lastErr = err;
        resolve(false);
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error(`HTTPS proxy never became ready on port ${port} within ${timeoutMs}ms (last: ${lastErr?.message})`);
}

async function spawnProxy(configYaml, label) {
  const cfgPath = path.join(os.tmpdir(), `ninja-tls-e2e-${label}-${process.pid}.yaml`);
  const logPath = path.join(os.tmpdir(), `ninja-tls-e2e-${label}-${process.pid}.log`);
  fs.writeFileSync(cfgPath, configYaml, "utf8");
  const logFd = fs.openSync(logPath, "a");
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", cfgPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  return { proc, cfgPath, logPath };
}

async function teardownProxy(handle) {
  if (!handle) return;
  await killProcessTree(handle.proc);
  try {
    fs.unlinkSync(handle.cfgPath);
  } catch {}
}

function baseConfig({ httpPort, httpsPort, tlsBlock, redirectHttp = true }) {
  return `
server:
  listen: ${httpPort}
  workers: 2
  compression: false
  # Defaults are 10MB request / 25MB response -- raised so the 20MB upload/download
  # integrity checks below exercise TLS streaming, not the body-size limiter.
  maxRequestBodyBytes: ${30 * 1024 * 1024}
  maxResponseBytes: ${30 * 1024 * 1024}

${tlsBlock}

observability:
  logging:
    level: warn

admin:
  enabled: false

upstreams:
  - id: tls-backend
    url: "http://127.0.0.1:${UP_PORT}"
    healthPath: "/"

routes:
  - path: "/tls-echo"
    upstreams: ["tls-backend"]
    cache: { enabled: false }
  - path: "/tls-upload"
    upstreams: ["tls-backend"]
    cache: { enabled: false }
  - path: "/tls-download"
    upstreams: ["tls-backend"]
    cache: { enabled: false }
  - path: "/tls-sse"
    upstreams: ["tls-backend"]
    cache: { enabled: false }
  - path: "/tls-ws"
    upstreams: ["tls-backend"]
    cache: { enabled: false }

loadBalancing:
  strategy: round-robin
  retry:
    maxAttempts: 1

cache:
  enabled: false
`;
}

// -----------------------------------------------------------------------------
// Scenario 1: tls.enabled + tls.cert/tls.key, redirectHttp: true (default), a
// non-default httpsPort -- the bulk of the positive-path assertions.
// -----------------------------------------------------------------------------
async function scenarioMain() {
  const HTTP_PORT = 8540;
  const HTTPS_PORT = 8543; // deliberately non-default (schema default is 8443)
  const configYaml = baseConfig({
    httpPort: HTTP_PORT,
    httpsPort: HTTPS_PORT,
    tlsBlock: `tls:\n  enabled: true\n  cert: "${certs.serverCertPath}"\n  key: "${certs.serverKeyPath}"\n  redirectHttp: true\n  httpsPort: ${HTTPS_PORT}\n`,
  });
  const handle = await spawnProxy(configYaml, "main");
  try {
    await waitForHttpsReady(HTTPS_PORT, certs.caCertPem, 20000);
    log(`Scenario 1 (main, redirectHttp:true, httpsPort:${HTTPS_PORT}) proxy ready.`);

    // 1a. HTTPS GET with the real CA pinned, over a keep-alive agent -- and the second
    // request actually reuses the first's socket (proves this isn't a fresh TLS handshake
    // per request).
    const agent = new https.Agent({ keepAlive: true, ca: certs.caCertPem });
    const get = (p) =>
      new Promise((resolve, reject) => {
        const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: p, method: "GET", agent }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), reusedSocket: req.reusedSocket === true }));
        });
        req.on("error", reject);
        req.end();
      });
    const r1 = await get("/tls-echo");
    const r2 = await get("/tls-echo");
    record(
      "1a. HTTPS GET succeeds with the server's own CA pinned, keep-alive socket reused across requests",
      r1.status === 200 && r2.status === 200 && r2.reusedSocket === true,
      `r1=${r1.status}, r2=${r2.status}, r2 reused socket=${r2.reusedSocket}`,
    );

    // 1b. X-Forwarded-Proto reflects the CLIENT's own (HTTPS) connection to the proxy.
    const echoBody = JSON.parse(r1.body.toString("utf8"));
    record("1b. X-Forwarded-Proto forwarded to the upstream is \"https\" for an HTTPS client request", echoBody.xfp === "https", `upstream observed x-forwarded-proto=${echoBody.xfp}`);

    // 1c. 20MB upload integrity over HTTPS.
    const uploadPayload = crypto.randomBytes(20 * 1024 * 1024);
    const uploadSha = crypto.createHash("sha256").update(uploadPayload).digest("hex");
    const uploadResult = await new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: "/tls-upload", method: "POST", agent, headers: { "Content-Length": uploadPayload.length } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, ...JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, parseError: true, raw });
          }
        });
      });
      req.on("error", reject);
      req.end(uploadPayload);
    });
    record(
      "1c. 20MB upload over HTTPS: upstream-observed SHA-256 matches",
      uploadResult.status === 200 && uploadResult.sha256 === uploadSha && uploadResult.bytes === uploadPayload.length,
      `status=${uploadResult.status}, bytes=${uploadResult.bytes}/${uploadPayload.length}, sha-match=${uploadResult.sha256 === uploadSha}` + (uploadResult.parseError ? `, raw=${uploadResult.raw}` : ""),
    );

    // 1d. 20MB download integrity over HTTPS.
    const dl = await get("/tls-download");
    const dlSha = crypto.createHash("sha256").update(dl.body).digest("hex");
    record(
      "1d. 20MB download over HTTPS: client-observed SHA-256 matches",
      dl.status === 200 && dl.body.length === DOWNLOAD_SIZE && dlSha === downloadSha,
      `status=${dl.status}, bytes=${dl.body.length}/${DOWNLOAD_SIZE}, sha-match=${dlSha === downloadSha}`,
    );

    // 1e. SSE over HTTPS.
    const sseResult = await new Promise((resolve, reject) => {
      const events = [];
      const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: "/tls-sse", method: "GET", ca: certs.caCertPem }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c.toString();
          events.push(...buf.split("\n\n").filter((l) => l.startsWith("data:")));
        });
        res.on("end", () => resolve({ status: res.statusCode, events }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    record(
      "1e. SSE stream works over HTTPS (both events received)",
      sseResult.status === 200 && sseResult.events.length >= 2,
      `status=${sseResult.status}, events=${JSON.stringify(sseResult.events)}`,
    );

    // 1f. WSS (WebSocket over TLS) tunnel.
    const wssResult = await new Promise((resolve, reject) => {
      const req = https.request({
        host: "127.0.0.1",
        port: HTTPS_PORT,
        path: "/tls-ws",
        method: "GET",
        ca: certs.caCertPem,
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13" },
      });
      req.on("upgrade", (res, socket) => {
        const parse = createFrameParser();
        socket.on("data", (chunk) => {
          const frames = parse(chunk);
          for (const f of frames) {
            if (f.opcode === 0x1) {
              resolve({ status: res.statusCode, payload: f.payload.toString() });
              socket.end();
              return;
            }
          }
        });
        socket.write(encodeFrame("ping-over-tls", { opcode: 0x1, masked: true }));
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("WSS upgrade timed out")), 5000);
      req.end();
    }).catch((err) => ({ error: err.message }));
    record(
      "1f. WSS: WebSocket tunnel works over TLS (upgrade + echoed frame)",
      wssResult.status === 101 && wssResult.payload === "echo:ping-over-tls",
      JSON.stringify(wssResult),
    );

    // 1g/1h. CA verification: an agent that does NOT trust this self-signed CA must reject
    // the handshake (proves verification is real, not silently bypassed); the identical
    // request with rejectUnauthorized:false (the one deliberate exception in this suite)
    // succeeds, isolating "it was certificate verification that failed" from any other
    // possible cause (wrong port, handshake mismatch, etc).
    const untrustedResult = await new Promise((resolve) => {
      const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: "/tls-echo", method: "GET", timeout: 3000 }, (res) => {
        res.resume();
        resolve({ connected: true, status: res.statusCode });
      });
      req.on("error", (err) => resolve({ connected: false, code: err.code }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ connected: false, code: "TIMEOUT" });
      });
      req.end();
    });
    record(
      "1g. A client that does NOT trust the proxy's self-signed CA is rejected (certificate verification is real, not bypassed)",
      untrustedResult.connected === false,
      JSON.stringify(untrustedResult),
    );
    const unverifiedButAllowedResult = await new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: "/tls-echo", method: "GET", rejectUnauthorized: false, timeout: 3000 }, (res) => {
        res.resume();
        resolve({ connected: true, status: res.statusCode });
      });
      req.on("error", reject);
      req.end();
    }).catch((err) => ({ connected: false, error: err.message }));
    record(
      "1h. The deliberate exception: the SAME request with rejectUnauthorized:false connects fine, isolating verification (not the handshake itself) as what 1g rejected",
      unverifiedButAllowedResult.connected === true && unverifiedButAllowedResult.status === 200,
      JSON.stringify(unverifiedButAllowedResult),
    );

    // 1i. redirectHttp: true -- a plain HTTP request to a normal route is redirected to https://.
    const redirectResult = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: HTTP_PORT, path: "/tls-echo", method: "GET" }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      });
      req.on("error", reject);
      req.end();
    });
    record(
      "1i. tls.redirectHttp:true redirects a plain-HTTP request to https://",
      redirectResult.status === 301 && typeof redirectResult.location === "string" && redirectResult.location.startsWith("https://") && redirectResult.location.includes(String(HTTPS_PORT)),
      JSON.stringify(redirectResult),
    );

    // 1j. ...but the documented exemption paths (e.g. /metrics) are served directly over
    // plain HTTP, not redirected -- this is existing, intentional behavior (worker.ts),
    // proven here rather than assumed.
    const metricsResult = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: HTTP_PORT, path: "/metrics", method: "GET" }, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      req.on("error", reject);
      req.end();
    });
    record("1j. The /metrics exemption path is served directly over plain HTTP, not redirected, even with redirectHttp:true", metricsResult.status === 200, JSON.stringify(metricsResult));
  } finally {
    await teardownProxy(handle);
  }
}

// -----------------------------------------------------------------------------
// Scenario 2: tls.redirectHttp: false -- the plain-HTTP port must serve the proxy
// directly instead of redirecting.
// -----------------------------------------------------------------------------
async function scenarioRedirectFalse() {
  const HTTP_PORT = 8550;
  const HTTPS_PORT = 8553;
  const configYaml = baseConfig({
    httpPort: HTTP_PORT,
    httpsPort: HTTPS_PORT,
    tlsBlock: `tls:\n  enabled: true\n  cert: "${certs.serverCertPath}"\n  key: "${certs.serverKeyPath}"\n  redirectHttp: false\n  httpsPort: ${HTTPS_PORT}\n`,
  });
  const handle = await spawnProxy(configYaml, "redirect-false");
  try {
    await waitForHttpsReady(HTTPS_PORT, certs.caCertPem, 20000);
    log("Scenario 2 (redirectHttp:false) proxy ready.");
    const httpResult = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: HTTP_PORT, path: "/tls-echo", method: "GET" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    record(
      "2. tls.redirectHttp:false serves the proxy directly over plain HTTP (no redirect) on the http port, even while HTTPS is also enabled",
      httpResult.status === 200,
      JSON.stringify(httpResult),
    );
  } finally {
    await teardownProxy(handle);
  }
}

// -----------------------------------------------------------------------------
// Scenario 3: legacy server.sslKeyPath/server.sslCertPath as the cert SOURCE (still
// requires tls.enabled: true -- that flag, not the legacy paths, is what actually turns
// on the HTTPS listener; see worker.ts's isTlsEnabled).
// -----------------------------------------------------------------------------
async function scenarioLegacySslPaths() {
  const HTTP_PORT = 8560;
  const HTTPS_PORT = 8563;
  const configYaml = `
server:
  listen: ${HTTP_PORT}
  workers: 1
  compression: false
  sslKeyPath: "${certs.serverKeyPath}"
  sslCertPath: "${certs.serverCertPath}"
  httpsPort: ${HTTPS_PORT}

tls:
  enabled: true
  httpsPort: ${HTTPS_PORT}

observability:
  logging:
    level: warn

admin:
  enabled: false

upstreams:
  - id: tls-backend
    url: "http://127.0.0.1:${UP_PORT}"
    healthPath: "/"

routes:
  - path: "/tls-echo"
    upstreams: ["tls-backend"]
    cache: { enabled: false }

loadBalancing:
  strategy: round-robin
  retry:
    maxAttempts: 1

cache:
  enabled: false
`;
  const handle = await spawnProxy(configYaml, "legacy-ssl-paths");
  try {
    await waitForHttpsReady(HTTPS_PORT, certs.caCertPem, 20000);
    log("Scenario 3 (legacy sslKeyPath/sslCertPath) proxy ready.");
    const r = await new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: "/tls-echo", method: "GET", ca: certs.caCertPem }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      });
      req.on("error", reject);
      req.end();
    });
    record("3. Legacy server.sslKeyPath/server.sslCertPath (with tls.enabled:true) still work as the certificate source", r.status === 200, JSON.stringify(r));
  } finally {
    await teardownProxy(handle);
  }
}

// -----------------------------------------------------------------------------
// Scenario 4: fail-fast on a missing/invalid certificate -- no crash loop (master.ts
// fix), no plaintext-HTTP fallback, a prompt non-zero exit.
// -----------------------------------------------------------------------------
async function scenarioFailFast() {
  const HTTP_PORT = 8570;
  const HTTPS_PORT = 8573;
  const configYaml = baseConfig({
    httpPort: HTTP_PORT,
    httpsPort: HTTPS_PORT,
    tlsBlock: `tls:\n  enabled: true\n  cert: "/nonexistent/path/cert.pem"\n  key: "/nonexistent/path/key.pem"\n  redirectHttp: true\n  httpsPort: ${HTTPS_PORT}\n`,
  });
  const handle = await spawnProxy(configYaml, "fail-fast");
  try {
    const exitInfo = await new Promise((resolve) => {
      let resolved = false;
      handle.proc.on("exit", (code, signal) => {
        if (resolved) return;
        resolved = true;
        resolve({ exited: true, code, signal });
      });
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        resolve({ exited: false });
      }, 15000);
    });
    let listenerBound = null;
    if (!exitInfo.exited) {
      // Still alive at 15s would itself be the failure (a crash loop, or a plaintext
      // fallback) -- check whether it's actually serving anything on the HTTP port.
      listenerBound = await new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: HTTP_PORT, path: "/", method: "GET", timeout: 1000 }, (res) => {
          res.resume();
          resolve(true);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
    }
    record(
      "4. A missing/invalid TLS certificate fails fast (non-zero exit, no crash loop, no plaintext-HTTP fallback)",
      exitInfo.exited === true && exitInfo.code !== 0,
      exitInfo.exited ? `exited within 15s: code=${exitInfo.code}, signal=${exitInfo.signal}` : `still running after 15s (crash loop or fallback?) -- HTTP listener bound=${listenerBound}`,
    );
  } finally {
    await teardownProxy(handle);
  }
}

function printSummary() {
  console.log("\n================================================================================");
  console.log("  TLS / HTTPS E2E SUITE — RESULTS");
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

let upstream;
async function cleanup() {
  try {
    await new Promise((r) => (upstream ? upstream.close(r) : r()));
  } catch {}
  try {
    fs.rmSync(certDir, { recursive: true, force: true });
  } catch {}
}

async function main() {
  certs = genCerts();
  log(`Generated self-signed CA + leaf cert in ${certDir}`);
  upstream = await startUpstream();
  log("Mock upstream ready.");

  await scenarioMain();
  await scenarioRedirectFalse();
  await scenarioLegacySslPaths();
  await scenarioFailFast();

  printSummary();
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
}

const HARD_TIMEOUT_MS = 5 * 60 * 1000;
let hardTimeoutTimer;
async function forceExit(reason, code) {
  console.error(`[tls-e2e] FATAL: ${reason} — forcing cleanup and exit`);
  clearTimeout(hardTimeoutTimer);
  await cleanup();
  process.exit(code);
}
hardTimeoutTimer = setTimeout(() => void forceExit(`hard timeout exceeded (${HARD_TIMEOUT_MS}ms)`, 1), HARD_TIMEOUT_MS);
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
    console.error(`[tls-e2e] FATAL: ${err?.stack || err}`);
    clearTimeout(hardTimeoutTimer);
    await cleanup();
    process.exit(1);
  });
