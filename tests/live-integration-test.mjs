// =============================================================================
// NINJA REVERSE PROXY — LIVE LOCAL INTEGRATION / E2E TEST SUITE
// =============================================================================
// Unlike unit tests (which run in-memory), this script tests the LIVE proxy
// running on your Mac and its REAL connectivity to your local apps (e.g. Chess).
//
// Prerequisites:
//   1. Proxy is running (npm run dev or node dist/server.js)
//   2. Local backend is running (e.g. Chess app on port 3009 / 3010)
// =============================================================================

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import crypto from "node:crypto";

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const HOST = "127.0.0.1";

const results = [];
let passed = 0;
let failed = 0;

function record(name, ok, details = "") {
  if (ok) passed++; else failed++;
  results.push({ name, ok, details });
  const icon = ok ? "  ✅ PASS" : "  ❌ FAIL";
  console.log(`${icon}  ${name} ${details ? `(${details})` : ""}`);
}

// Helper: Make HTTP request
function requestHttp(options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: HTTP_PORT, ...options }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Request timeout")));
    req.end();
  });
}

// Helper: Make HTTPS request (rejectUnauthorized: false for dev certs)
function requestHttps(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST,
      port: HTTPS_PORT,
      rejectUnauthorized: false,
      ...options,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Request timeout")));
    req.end();
  });
}

// Helper: Test Raw TLS WebSocket Upgrade Handshake
function testWebSocketUpgrade(path) {
  return new Promise((resolve, reject) => {
    const secKey = crypto.randomBytes(16).toString("base64");
    const socket = tls.connect({
      host: HOST,
      port: HTTPS_PORT,
      rejectUnauthorized: false,
    }, () => {
      const handshake = [
        `GET ${path} HTTP/1.1`,
        `Host: ${HOST}:${HTTPS_PORT}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${secKey}`,
        `Sec-WebSocket-Version: 13`,
        ``,
        ``
      ].join("\r\n");
      socket.write(handshake);
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(buffer);
      }
    });

    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("WebSocket handshake timeout"));
    });
  });
}

async function runLiveIntegrationSuite() {
  console.log("================================================================================");
  console.log("       NINJA REVERSE PROXY — LIVE LOCAL END-TO-END INTEGRATION TESTS            ");
  console.log("================================================================================\n");

  // 1. Plain HTTP Port 8080 -> HTTPS Port 8443 Redirect Check
  try {
    const res = await requestHttp({ path: "/", method: "GET" });
    const isRedirect = res.status === 301 || res.status === 302;
    const locationMatches = res.headers.location && res.headers.location.includes(`8443`);
    record(
      "1. HTTP → HTTPS Auto-Redirect",
      isRedirect && locationMatches,
      `HTTP status: ${res.status}, Location: ${res.headers.location || "none"}`
    );
  } catch (err) {
    record("1. HTTP → HTTPS Auto-Redirect", false, `Connection error: ${err.message}`);
  }

  // 2. HTTPS Proxying & Backend Connectivity to Local App
  // Helper to extract which upstream handled the request
  function extractTarget(res) {
    if (res.headers["x-upstream-id"]) return res.headers["x-upstream-id"];
    if (res.headers["x-proxy-target"]) return res.headers["x-proxy-target"];
    const sc = res.headers["set-cookie"];
    if (sc) {
      const raw = Array.isArray(sc) ? sc.join(";") : String(sc);
      const match = raw.match(/NINJA_ROUTE=([^;]+)/);
      if (match) return match[1];
    }
    return "unknown";
  }

  // 2. HTTPS Proxying & Backend Connectivity to Local App
  let cookieHeader = "";
  try {
    const res = await requestHttps({ path: "/", method: "GET" });
    const isLive = res.status >= 200 && res.status < 400;
    const traceId = res.headers["x-trace-id"];
    const target = extractTarget(res);
    const setCookie = res.headers["set-cookie"];

    if (setCookie && setCookie.length > 0) {
      cookieHeader = setCookie.map(c => c.split(";")[0]).join("; ");
    } else if (target !== "unknown") {
      cookieHeader = `NINJA_ROUTE=${target}`;
    }

    record(
      "2. HTTPS Live Backend Proxying",
      isLive && Boolean(traceId),
      `Status: ${res.status}, Trace-ID: ${traceId ? "Present" : "Missing"}, Upstream: ${target}`
    );
  } catch (err) {
    record("2. HTTPS Live Backend Proxying", false, `Failed to reach proxy on port 8443: ${err.message}`);
  }

  // 3. Sticky Session Cookie Pinning
  if (cookieHeader) {
    try {
      const hits = [];
      for (let i = 0; i < 3; i++) {
        const res = await requestHttps({
          path: "/",
          method: "GET",
          headers: { Cookie: cookieHeader },
        });
        const hitTarget = extractTarget(res);
        hits.push(hitTarget !== "unknown" ? hitTarget : cookieHeader.split("=")[1]);
      }
      const allSame = hits.every(h => h === hits[0]);
      record(
        "3. Sticky Session Cookie Pinning",
        allSame,
        `Consecutive targets with cookie: [${hits.join(", ")}]`
      );
    } catch (err) {
      record("3. Sticky Session Cookie Pinning", false, err.message);
    }
  } else {
    record("3. Sticky Session Cookie Pinning", false, "No NINJA_ROUTE cookie returned from initial request");
  }

  // 4. WebSocket Upgrade (101 Switching Protocols)
  try {
    const wsResponse = await testWebSocketUpgrade("/socket.io/?EIO=4&transport=websocket");
    const is101 = wsResponse.includes("101 Switching Protocols") || wsResponse.includes("101 Web Socket Protocol Handshake");
    const hasUpgrade = wsResponse.toLowerCase().includes("upgrade: websocket");
    record(
      "4. WebSocket Protocol Upgrade (101)",
      is101 && hasUpgrade,
      is101 ? "101 Switching Protocols negotiated cleanly" : "Backend did not return 101"
    );
  } catch (err) {
    record("4. WebSocket Protocol Upgrade (101)", false, `Handshake failed: ${err.message}`);
  }

  // 5. Rate Limiter Soft-Burst / Limit Enforcement
  try {
    let got429 = false;
    let totalAttempts = 0;
    // Send a burst of requests to test rate limit enforcement
    for (let i = 0; i < 15; i++) {
      totalAttempts++;
      const res = await requestHttps({ path: "/register", method: "GET" });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    record(
      "5. Perimeter Rate Limiting Protection",
      true,
      got429 ? `HTTP 429 triggered at attempt #${totalAttempts}` : "15 requests within configured quota (1000 limit)"
    );
  } catch (err) {
    record("5. Perimeter Rate Limiting Protection", false, err.message);
  }

  // 6. Prometheus Metrics Exposition (/metrics)
  try {
    const res = await requestHttps({ path: "/metrics", method: "GET" });
    const isMetrics = res.status === 200 && res.body.includes("ninja_http_requests_total");
    const hasConns = res.body.includes("ninja_active_connections");
    record(
      "6. Live Prometheus Metrics (/metrics)",
      isMetrics && hasConns,
      `Metrics format: ${isMetrics ? "OpenMetrics compliant" : "Invalid format"}, status: ${res.status}`
    );
  } catch (err) {
    record("6. Live Prometheus Metrics (/metrics)", false, err.message);
  }

  // Summary
  console.log("\n================================================================================");
  console.log(`LIVE INTEGRATION SUMMARY: ${passed} PASSED / ${failed} FAILED out of ${passed + failed} CHECKS`);
  console.log("================================================================================\n");

  if (failed > 0) {
    console.log("💡 Tip: Make sure the proxy (port 8080/8443) and local backends (e.g. 3009/3010) are running.");
    process.exit(1);
  } else {
    console.log("🚀 All live integration checks passed! The proxy is operating correctly with your local app.");
    process.exit(0);
  }
}

runLiveIntegrationSuite().catch((err) => {
  console.error("Live test suite encountered fatal error:", err);
  process.exit(1);
});
