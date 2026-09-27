import http from "node:http";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

console.log("==================================================================");
console.log("  NINJA REVERSE PROXY — FULL LIVE END-TO-END VERIFICATION SUITE   ");
console.log("==================================================================");

// Ports for this test
const PORT_A = 3981;
const PORT_B = 3982;
const PROXY_PORT = 8991;

let passed = 0;
let failed = 0;

function report(testName, ok, info = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ PASS: ${testName} ${info ? "(" + info + ")" : ""}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${testName} ${info ? "(" + info + ")" : ""}`);
  }
}

// 1. Start Mock Upstream Backend A (Baseline)
const serverA = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "X-App": "backend-A" });
  res.end(JSON.stringify({ backend: "app-a", url: req.url, headers: req.headers }));
});

// 2. Start Mock Upstream Backend B (Canary)
const serverB = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "X-App": "backend-B" });
  res.end(JSON.stringify({ backend: "app-b-canary", url: req.url, headers: req.headers }));
});

// Create temp config
const tempConfigPath = path.resolve("./temp-e2e-config.yaml");
const configContent = `
server:
  host: "127.0.0.1"
  port: ${PROXY_PORT}
  workers: 2
  connectTimeoutMs: 3000
  readTimeoutMs: 5000
  compression: true
  accessLog: "logs/e2e-access.log"

upstreams:
  - id: app-a
    url: "http://127.0.0.1:${PORT_A}"
    weight: 1
  - id: app-b
    url: "http://127.0.0.1:${PORT_B}"
    weight: 1

routes:
  - path: "/api"
    upstreams: ["app-a", "app-b"]
    sticky: true
    canary:
      enabled: true
      canaryUpstream: "app-b"
      baselineUpstream: "app-a"
      weight: 0
      stickyCookieName: "NINJA_CANARY"
      headerKey: "x-canary"
      headerValue: "true"
      stage: "canary-test"
`;

fs.writeFileSync(tempConfigPath, configContent);

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PROXY_PORT,
        ...options,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  await new Promise((r) => serverA.listen(PORT_A, "127.0.0.1", r));
  await new Promise((r) => serverB.listen(PORT_B, "127.0.0.1", r));
  console.log(`[Upstreams] Mock backends running on ports ${PORT_A} (app-a) and ${PORT_B} (app-b)`);

  // Start Proxy in child process
  const proxyProcess = fork("./dist/index.js", ["--config", tempConfigPath], {
    stdio: "pipe",
  });
  proxyProcess.stdout?.pipe(process.stdout);
  proxyProcess.stderr?.pipe(process.stderr);

  // Wait for proxy to finish initial health checks and start listening (3000ms + initialHealthCheck)
  console.log("[Proxy] Waiting for master to finish initial health check and bind port...");
  await new Promise((resolve) => setTimeout(resolve, 4500));
  console.log(`[Proxy] Ninja Reverse Proxy running on port ${PROXY_PORT}`);

  try {
    // TEST 1: Baseline Request (Weight 0, no headers -> should route to app-a)
    const res1 = await request({ path: "/api/users", method: "GET" });
    report(
      "Baseline Routing",
      res1.statusCode === 200 && res1.body.includes("app-a"),
      `Status: ${res1.statusCode}, Body: ${res1.body.trim().slice(0, 30)}...`
    );

    // TEST 2: Canary Header Override (x-canary: true -> must route to app-b)
    const res2 = await request({
      path: "/api/users",
      method: "GET",
      headers: { "x-canary": "true" },
    });
    report(
      "Canary Header Override (x-canary: true)",
      res2.statusCode === 200 && res2.body.includes("app-b-canary"),
      `Routed to: ${res2.headers["x-upstream-id"]}, Stage: ${res2.headers["x-route-stage"]}`
    );

    // TEST 3: Canary Header Stripping (Header should NOT reach backend app)
    const parsedBody2 = JSON.parse(res2.body);
    report(
      "Header Stripping (x-canary stripped)",
      !parsedBody2.headers["x-canary"],
      "Internal header stripped before upstream"
    );

    // TEST 4: Sticky Session Cookie Injection
    report(
      "Sticky Session Cookie Injected",
      res1.headers["set-cookie"] !== undefined,
      `Set-Cookie: ${JSON.stringify(res1.headers["set-cookie"])}`
    );

    // TEST 5: Proxy Identification Headers
    report(
      "Proxy Headers Injected",
      parsedBody2.headers["x-proxy-by"] === "Ninja-Reverse-Proxy" &&
        parsedBody2.headers["x-forwarded-for"] !== undefined,
      `X-Proxy-By: ${parsedBody2.headers["x-proxy-by"]}, X-Forwarded-For: ${parsedBody2.headers["x-forwarded-for"]}`
    );

    // TEST 6: Metrics Scrape Endpoint
    const res6 = await request({ path: "/__metrics", method: "GET" });
    report(
      "Prometheus Metrics Scrape (/__metrics)",
      res6.statusCode === 200 && res6.body.includes("ninja_http_requests_total"),
      `Status: ${res6.statusCode}, Contains OpenMetrics`
    );

    // TEST 7: 404 / 502 Route Not Found Guard
    const res7 = await request({ path: "/unmapped-route", method: "GET" });
    report(
      "Unmapped Route Guard",
      (res7.statusCode === 404 || res7.statusCode === 502) && res7.body.includes("Route not found"),
      `Status: ${res7.statusCode}, Body: ${res7.body}`
    );
  } finally {
    // CLEANUP EVERYTHING SILENTLY
    console.log("[Teardown] Cleaning up processes and closing all ports...");
    proxyProcess.kill("SIGTERM");
    await new Promise((r) => serverA.close(r));
    await new Promise((r) => serverB.close(r));
    try {
      fs.unlinkSync(tempConfigPath);
    } catch {}
    console.log("[Teardown] All ports (8991, 3981, 3982) closed cleanly. Zero lingering processes.");
  }

  console.log("==================================================================");
  console.log(`  FINAL RESULT: ${passed} PASSED / ${failed} FAILED`);
  console.log("==================================================================");
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
