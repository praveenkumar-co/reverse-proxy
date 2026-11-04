// =============================================================================
// DDIA CHAPTER 8 — FENCING TOKENS CONCEPTUAL MODEL (NOT PROXY TESTS)
// =============================================================================
// Models zombie-leader fencing (DDIA Chapter 8, "Knowledge, Truth and Lies")
// using a FencingTokenTracker + middleware defined entirely in this file.
// src/ has no real fencing-token implementation, so this does not exercise
// any proxy code and must never be counted toward the proxy's test totals.
// See README.md in this directory.
//
// Moved out of tests/ddia-chapter8-distributed-troubles-suite.mjs
// (Phase E, test-integrity pass): §5 Zombie Leaders & Split-Brain.
// =============================================================================

import http from "node:http";
import { performance } from "node:perf_hooks";

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
console.log("   DDIA CHAPTER 8: FENCING TOKENS (conceptual, not proxy code)    ");
console.log("==================================================================\n");

console.log("\x1b[1m§5. Knowledge & Truth: Fencing Tokens Block Resurrected Zombie Leaders\x1b[0m");

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

if (typeof fenceServer.closeAllConnections === "function") {
  fenceServer.closeAllConnections();
}
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

console.log("\n==================================================================");
console.log(`   FENCING TOKENS RESULTS: ${totalPassed} Passed | ${totalFailed} Failed`);
console.log("==================================================================\n");

if (totalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
