// =============================================================================
// SSRF (ADMIN REGISTRATION) SUITE (Phase G, Item 3)
// =============================================================================
// POST /__registry/register used to be default-permissive: an empty
// admin.registrationAllowlist meant ANY hostname was accepted, and the only
// unconditional block was a narrow link-local/cloud-metadata check that didn't even cover
// loopback or RFC1918 private ranges. A tenant able to reach this endpoint could register
// "http://127.0.0.1:<internal-port>/" or "http://10.0.0.5/" and have the proxy dispatch real
// traffic to it, reading back whatever it returned through the proxy's own response.
//
// Scope, confirmed by reading admin.handler.ts before changing it: this ONLY affects
// POST /__registry/register. Config-file upstreams (server.yaml's `upstreams:` list) are
// never passed through this code path at all and are completely unaffected.
//
// Two scenarios, each its own proxy instance:
//   A. Default (empty) registrationAllowlist -- every denied-range literal/hostname case,
//      plus userinfo/scheme/port rejection, plus proof that a normal public address is
//      allowed by default (no allowlist needed for the common case).
//   B. A configured registrationAllowlist -- proof that it's a narrow exception (only the
//      listed CIDRs/hosts are exempted, nothing else), AND an end-to-end proof that an
//      allowlisted registration still actually works for real traffic (the DNS-pinning
//      fix didn't break the registration-to-dispatch path).
//
// Usage: node tests/ssrf-admin.mjs
// =============================================================================
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "./helpers/kill-process-tree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN_TOKEN = "ssrf-test-admin-secret";

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? "\x1b[32m✅ PASS\x1b[0m" : "\x1b[31m❌ FAIL\x1b[0m";
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function log(msg) {
  console.log(`[ssrf-admin] ${msg}`);
}

function adminRequest(port, urlPath, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: { "x-admin-token": ADMIN_TOKEN, "Content-Type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { parseError: true, raw };
          }
          resolve({ status: res.statusCode, ...parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function register(port, id, url) {
  return adminRequest(port, "/__registry/register", { method: "POST", body: { id, url } });
}
async function deregister(port, id) {
  return adminRequest(port, `/__registry/deregister/${id}`, { method: "DELETE" });
}

// -----------------------------------------------------------------------------
// Proxy lifecycle
// -----------------------------------------------------------------------------
async function waitForReady(port, path_, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: path_, method: "GET", timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode > 0);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error(`Proxy never became ready on port ${port} within ${timeoutMs}ms`);
}

// Tracked so a forced exit (hard timeout/signal/uncaught exception) mid-scenario can still
// kill whichever proxy is currently running, not just the one the normal finally-block path
// would have reached.
const liveHandles = new Set();

async function spawnProxy(configYaml, label) {
  const cfgPath = path.join(os.tmpdir(), `ninja-ssrf-admin-${label}-${process.pid}.yaml`);
  const logPath = path.join(os.tmpdir(), `ninja-ssrf-admin-${label}-${process.pid}.log`);
  fs.writeFileSync(cfgPath, configYaml, "utf8");
  const logFd = fs.openSync(logPath, "a");
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, "dist/index.js"), "--config", cfgPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  const handle = { proc, cfgPath, logPath };
  liveHandles.add(handle);
  return handle;
}
async function teardownProxy(handle) {
  if (!handle) return;
  liveHandles.delete(handle);
  await killProcessTree(handle.proc);
  try {
    fs.unlinkSync(handle.cfgPath);
  } catch {}
}

function baseConfig({ port, registrationAllowlist, upstreamPort }) {
  return `
server:
  listen: ${port}
  workers: 1
  compression: false

tls:
  enabled: false

observability:
  logging:
    level: warn

admin:
  enabled: true
  token: "${ADMIN_TOKEN}"
  registrationAllowlist: [${registrationAllowlist.map((e) => `"${e}"`).join(", ")}]

upstreams:
  - id: static-backend
    url: "http://127.0.0.1:${upstreamPort}"
    healthPath: "/"

routes:
  - path: "/dyn"
    upstreams: ["dyn-upstream"]
    cache: { enabled: false }
  - path: "/static"
    upstreams: ["static-backend"]
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
// Scenario A: empty registrationAllowlist (default-deny only).
// -----------------------------------------------------------------------------
async function scenarioDefaultDeny() {
  const PORT = 8580;
  const UP_PORT = 4740;
  const handle = await spawnProxy(baseConfig({ port: PORT, registrationAllowlist: [], upstreamPort: UP_PORT }), "default-deny");
  try {
    await waitForReady(PORT, "/static", 20000);
    log("Scenario A (empty registrationAllowlist) proxy ready.");

    const deniedCases = [
      ["IPv4 loopback", "http://127.0.0.1:9999/"],
      ["IPv4 private 10.0.0.0/8", "http://10.1.2.3/"],
      ["IPv4 private 172.16.0.0/12 (lower bound)", "http://172.16.0.5/"],
      ["IPv4 private 172.16.0.0/12 (upper bound)", "http://172.31.255.254/"],
      ["IPv4 private 192.168.0.0/16", "http://192.168.1.1/"],
      ["IPv4 link-local / cloud metadata (169.254.169.254)", "http://169.254.169.254/"],
      ["IPv4 unspecified (0.0.0.0)", "http://0.0.0.0:80/"],
      ["IPv4 multicast (224.0.0.1)", "http://224.0.0.1/"],
      ["IPv4 broadcast (255.255.255.255)", "http://255.255.255.255/"],
      ["IPv6 loopback (::1)", "http://[::1]:9999/"],
      ["IPv6 link-local (fe80::1)", "http://[fe80::1]/"],
      ["IPv6 unique-local / private (fc00::1)", "http://[fc00::1]/"],
      ["IPv6 unspecified (::)", "http://[::]/"],
      ["IPv6 multicast (ff02::1)", "http://[ff02::1]/"],
      ["IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", "http://[::ffff:127.0.0.1]/"],
      ["userinfo in URL", "http://user:pass@8.8.8.8/"],
      ["disallowed scheme", "ftp://8.8.8.8/"],
      ["unresolvable hostname", "http://this-host-does-not-exist.invalid.test/"],
    ];
    let allDenied = true;
    const denyDetails = [];
    for (const [label, url] of deniedCases) {
      const r = await register(PORT, `ssrf-${Math.random().toString(36).slice(2)}`, url);
      const denied = r.status === 403;
      if (!denied) allDenied = false;
      denyDetails.push(`${label}: status=${r.status}${denied ? "" : ` (EXPECTED 403) body=${JSON.stringify(r)}`}`);
    }
    record("A1. Every denied-range/malformed registration case is rejected with 403", allDenied, denyDetails.filter((d) => d.includes("EXPECTED")).join("; ") || `all ${deniedCases.length} cases correctly denied`);

    // A2. A normal public literal IP is allowed BY DEFAULT, with no allowlist entries at all
    // (literal IP -- no DNS lookup needed, so this doesn't depend on network access).
    const publicResult = await register(PORT, "ssrf-public-ok", "http://8.8.8.8:80/");
    record("A2. A normal public address is allowed by default (no allowlist needed)", publicResult.status === 201, `status=${publicResult.status}, body=${JSON.stringify(publicResult)}`);
    if (publicResult.status === 201) await deregister(PORT, "ssrf-public-ok");
  } finally {
    await teardownProxy(handle);
  }
}

// -----------------------------------------------------------------------------
// Scenario B: a configured registrationAllowlist -- narrow exception, and proof the
// registration-to-dispatch path still actually works for an allowlisted upstream.
// -----------------------------------------------------------------------------
async function scenarioAllowlistException() {
  const PORT = 8590;
  const UP_PORT = 4741;
  const DYN_PORT = 4742;

  const dynUpstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello-from-dynamic-upstream");
  });
  await new Promise((resolve, reject) => {
    dynUpstream.on("error", reject);
    dynUpstream.listen(DYN_PORT, "127.0.0.1", resolve);
  });

  const handle = await spawnProxy(baseConfig({ port: PORT, registrationAllowlist: ["127.0.0.1/32", "10.0.0.0/8"], upstreamPort: UP_PORT }), "allowlist");
  try {
    await waitForReady(PORT, "/static", 20000);
    log("Scenario B (registrationAllowlist: 127.0.0.1/32, 10.0.0.0/8) proxy ready.");

    // B1. The exact-/32 exemption now allows the loopback registration that scenario A denied.
    const loopbackResult = await register(PORT, "dyn-upstream", `http://127.0.0.1:${DYN_PORT}/`);
    record("B1. 127.0.0.1 registration succeeds once exempted via registrationAllowlist (127.0.0.1/32)", loopbackResult.status === 201, `status=${loopbackResult.status}, body=${JSON.stringify(loopbackResult)}`);

    // B2. The exemption is narrow: an address NOT covered by either allowlist entry is still denied.
    const stillDeniedResult = await register(PORT, "ssrf-still-denied", "http://192.168.1.1/");
    record("B2. An address not covered by any allowlist entry is still denied (the exemption is narrow, not blanket)", stillDeniedResult.status === 403, `status=${stillDeniedResult.status}, body=${JSON.stringify(stillDeniedResult)}`);

    // B3. The CIDR form of the exemption (10.0.0.0/8, not just an exact /32) is honored.
    const cidrAllowedResult = await register(PORT, "ssrf-cidr-ok", "http://10.5.6.7:80/");
    record("B3. CIDR-range allowlist entry (10.0.0.0/8) exempts any address within it, not just an exact match", cidrAllowedResult.status === 201, `status=${cidrAllowedResult.status}, body=${JSON.stringify(cidrAllowedResult)}`);
    if (cidrAllowedResult.status === 201) await deregister(PORT, "ssrf-cidr-ok");

    // B4. End-to-end: the registered-and-allowlisted upstream actually serves real traffic
    // through the proxy -- proves the DNS-pinning fix (storing the validated address in
    // metadata.pinnedAddress and connecting to it) didn't break the normal register-then-
    // dispatch path for a legitimately allowlisted upstream.
    await sleep(500); // let the health prober mark it up
    const dispatchResult = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: PORT, path: "/dyn", method: "GET" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    record(
      "B4. End-to-end: real traffic through the proxy reaches the allowlisted, pinned-address dynamic upstream",
      dispatchResult.status === 200 && dispatchResult.body === "hello-from-dynamic-upstream",
      JSON.stringify(dispatchResult),
    );
  } finally {
    await teardownProxy(handle);
    try {
      await new Promise((r) => dynUpstream.close(r));
    } catch {}
  }
}

function printSummary() {
  console.log("\n================================================================================");
  console.log("  SSRF (ADMIN REGISTRATION) SUITE — RESULTS");
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
  await scenarioDefaultDeny();
  await scenarioAllowlistException();
  printSummary();
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
}

const HARD_TIMEOUT_MS = 5 * 60 * 1000;
let hardTimeoutTimer;
async function forceExit(reason, code) {
  console.error(`[ssrf-admin] FATAL: ${reason} — forcing cleanup and exit`);
  clearTimeout(hardTimeoutTimer);
  for (const handle of [...liveHandles]) await teardownProxy(handle);
  process.exit(code);
}
hardTimeoutTimer = setTimeout(() => void forceExit(`hard timeout exceeded (${HARD_TIMEOUT_MS}ms)`, 1), HARD_TIMEOUT_MS);
process.on("SIGINT", () => void forceExit("received SIGINT", 130));
process.on("SIGTERM", () => void forceExit("received SIGTERM", 143));
process.on("uncaughtException", (err) => void forceExit(`uncaughtException: ${err?.stack || err}`, 1));
process.on("unhandledRejection", (reason) => void forceExit(`unhandledRejection: ${reason?.stack || reason}`, 1));

main()
  .then(() => {
    clearTimeout(hardTimeoutTimer);
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error(`[ssrf-admin] FATAL: ${err?.stack || err}`);
    clearTimeout(hardTimeoutTimer);
    process.exit(1);
  });
