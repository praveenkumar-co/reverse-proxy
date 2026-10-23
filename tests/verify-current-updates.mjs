// =============================================================================
// VERIFY CURRENT UPDATES: Dedicated Test Suite for Newly Wired Features
// =============================================================================
import http from "node:http";
import { RouteMatcher } from "../dist/core/router/route.matcher.js";
import { Cache } from "../dist/cache/cache-manager.js";
import { KeyBuilder } from "../dist/cache/policies/key-builder.js";
import { parseCacheControl } from "../dist/cache/policies/cache-control.parser.js";
import { StaleIfError } from "../dist/cache/policies/stale-if-error.js";
import { StaleWhileRevalidate } from "../dist/cache/policies/stale-while-revalidate.js";
import { TagInvalidator } from "../dist/cache/invalidation/tag.invalidator.js";
import { PatternInvalidator } from "../dist/cache/invalidation/pattern.invalidator.js";
import { authMiddleware } from "../dist/middleware/auth.middleware.js";
import { getAgent } from "../dist/core/proxy/connection.pool.js";

const results = [];

function assert(description, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    results.push({ description, status: "PASS", details });
  } else {
    console.error(`  ❌ FAIL: ${description} ${details ? `(${details})` : ""}`);
    results.push({ description, status: "FAIL", details });
  }
}

console.log("\n==================================================================");
console.log("   VERIFYING ALL CURRENT ARCHITECTURAL SURGERY UPDATES            ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// 1. ROUTE MATCHER: Method Guards & Longest-Prefix Specificity
// -----------------------------------------------------------------------------
console.log("§1. RouteMatcher: Method Guards & Prefix Specificity");
const routes = [
  { path: "/api", upstream: ["app-default"], methods: ["GET", "HEAD"] },
  { path: "/api/orders", upstream: ["app-orders"], methods: ["POST"] },
  { path: "/api/v2/items", upstream: ["app-v2"] }, // no method restriction
  { path: "/api/v2", upstream: ["app-v2-fallback"] },
  { path: "/", upstream: ["app-root"] }
];
const matcher = new RouteMatcher(routes);

const getMatch = matcher.match("/api/users", "GET");
assert("RouteMatcher allows GET on /api route declared with methods: ['GET', 'HEAD']", 
  getMatch?.upstream[0] === "app-default"
);

const postBlock = matcher.match("/api/users", "POST");
assert("RouteMatcher skips /api for POST and falls back to catch-all '/'", 
  postBlock?.upstream[0] === "app-root"
);

const postOrder = matcher.match("/api/orders", "POST");
assert("RouteMatcher matches POST /api/orders to app-orders", 
  postOrder?.upstream[0] === "app-orders"
);

const v2Specificity = matcher.match("/api/v2/items/123", "GET");
assert("RouteMatcher picks longest prefix (/api/v2/items beats /api/v2 and /api)", 
  v2Specificity?.upstream[0] === "app-v2"
);

// -----------------------------------------------------------------------------
// 2. CACHE POLICIES: KeyBuilder & Cache-Control Parsing
// -----------------------------------------------------------------------------
console.log("\n§2. Cache Policies: KeyBuilder & Cache-Control Directives");
const keyBuilder = new KeyBuilder({
  ignoreQueryParams: ["utm_source", "fbclid"],
  varyHeaders: ["accept-encoding", "x-tenant-id"],
  prefix: "ninja"
});

const key1 = keyBuilder.build("GET", "/api/products?id=10&utm_source=google", {
  "accept-encoding": "gzip",
  "x-tenant-id": "tenant-a"
});
const key2 = keyBuilder.build("GET", "/api/products?id=10&fbclid=xyz", {
  "accept-encoding": "gzip",
  "x-tenant-id": "tenant-a"
});
const keyDifferentVary = keyBuilder.build("GET", "/api/products?id=10", {
  "accept-encoding": "br",
  "x-tenant-id": "tenant-a"
});

assert("KeyBuilder strips ignored tracking query parameters (utm_source, fbclid)", 
  key1 === key2
);
assert("KeyBuilder incorporates vary headers into cache key", 
  key1 !== keyDifferentVary && key1.includes("accept-encoding=gzip")
);

const ccNoStore = parseCacheControl("no-store, no-cache, private");
assert("CacheControlParser detects noStore, noCache, private flags", 
  ccNoStore.noStore === true && ccNoStore.noCache === true && ccNoStore.private === true
);

const ccMaxAge = parseCacheControl("public, max-age=3600, s-maxage=7200");
assert("CacheControlParser extracts maxAge and sMaxAge numerical directives", 
  ccMaxAge.maxAge === 3600 && ccMaxAge.sMaxAge === 7200 && !ccMaxAge.noStore
);

// -----------------------------------------------------------------------------
// 3. TAG-BASED CACHE INVALIDATION (TagInvalidator & PatternInvalidator)
// -----------------------------------------------------------------------------
console.log("\n§3. Tag & Pattern Cache Invalidation");
const tagInv = new TagInvalidator();
tagInv.tag("cache:/api/users/1", ["users", "user:1", "tenant:acme"]);
tagInv.tag("cache:/api/users/2", ["users", "user:2", "tenant:acme"]);
tagInv.tag("cache:/api/orders/99", ["orders", "tenant:acme"]);

assert("TagInvalidator associates multiple tags with cache keys", 
  tagInv.getKeysForTag("tenant:acme").length === 3 &&
  tagInv.getKeysForTag("users").length === 2 &&
  tagInv.getKeysForTag("user:1").includes("cache:/api/users/1")
);

tagInv.removeTag("users");
assert("TagInvalidator evicts specific tag group while preserving other tags", 
  tagInv.getKeysForTag("users").length === 0 &&
  tagInv.getKeysForTag("tenant:acme").length === 3
);

let evictedPattern = "";
const mockStore = { invalidate: async (p) => { evictedPattern = p; } };
const patternInv = new PatternInvalidator(mockStore);

await patternInv.invalidate("cache:api:users:*");
assert("PatternInvalidator passes glob pattern to store.invalidate()", 
  evictedPattern === "cache:api:users:*"
);

// -----------------------------------------------------------------------------
// 4. STALE-WHILE-REVALIDATE & STALE-IF-ERROR POLICIES
// -----------------------------------------------------------------------------
console.log("\n§4. Stale-While-Revalidate & Stale-If-Error Policies");
const sie = new StaleIfError();
assert("StaleIfError serves stale copy on 500/502/503 within window", 
  sie.shouldServeStale(502, 86400, 120) === true
);
assert("StaleIfError does NOT serve stale on 200 OK or 404 Not Found", 
  sie.shouldServeStale(200, 86400, 120) === false &&
  sie.shouldServeStale(404, 86400, 120) === false
);
assert("StaleIfError does NOT serve stale when entry age exceeds stale-if-error window", 
  sie.shouldServeStale(500, 3600, 7200) === false
);

const swr = new StaleWhileRevalidate();
assert("StaleWhileRevalidate flags stale entry for background refresh", 
  swr.shouldRevalidate("key-abc", 65, 60) === true
);
swr.markRevalidating("key-abc");
assert("StaleWhileRevalidate deduplicates background refresh (does not re-trigger while in-flight)", 
  swr.shouldRevalidate("key-abc", 70, 60) === false
);
swr.markDone("key-abc");
assert("StaleWhileRevalidate unlocks key once refresh completes", 
  swr.shouldRevalidate("key-abc", 75, 60) === true
);

// -----------------------------------------------------------------------------
// 5. ROUTE-LEVEL AUTHENTICATION MIDDLEWARE
// -----------------------------------------------------------------------------
console.log("\n§5. Route-Level Authentication Middleware");
const allowedTokens = new Set(["tok_secret_production_123", "tok_dev_456"]);
const authGuard = authMiddleware(allowedTokens);

let nextCalled = false;
let capturedStatus = 0;

// Test A: Missing Authorization Header
const mockReqNoAuth = { headers: {} };
const mockResNoAuth = {
  writeHead(status) { capturedStatus = status; },
  end() {}
};
await authGuard({ req: mockReqNoAuth, res: mockResNoAuth }, async () => { nextCalled = true; });

assert("AuthMiddleware rejects request with no Authorization header with 401 Unauthorized", 
  capturedStatus === 401 && !nextCalled
);

// Test B: Invalid Token
nextCalled = false;
capturedStatus = 0;
const mockReqBadToken = { headers: { authorization: "Bearer invalid_token" } };
await authGuard({ req: mockReqBadToken, res: mockResNoAuth }, async () => { nextCalled = true; });

assert("AuthMiddleware rejects invalid token with 401 Unauthorized", 
  capturedStatus === 401 && !nextCalled
);

// Test C: Valid Token
nextCalled = false;
capturedStatus = 0;
const mockReqValid = { headers: { authorization: "Bearer tok_secret_production_123" } };
await authGuard({ req: mockReqValid, res: mockResNoAuth }, async () => { nextCalled = true; });

assert("AuthMiddleware admits valid token and advances pipeline to next()", 
  nextCalled === true
);

// -----------------------------------------------------------------------------
// 6. CENTRALIZED CONNECTION POOL
// -----------------------------------------------------------------------------
console.log("\n§6. Centralized Connection Pool");
const httpAgent1 = getAgent(false);
const httpAgent2 = getAgent(false);
const httpsAgent = getAgent(true);

assert("ConnectionPool provides singleton agent instance for HTTP", 
  httpAgent1 === httpAgent2 && httpAgent1 instanceof http.Agent
);
assert("ConnectionPool configures keepAlive=true and maxSockets=256", 
  httpAgent1.keepAlive === true && httpAgent1.maxSockets === 256
);
assert("ConnectionPool provides distinct https.Agent for HTTPS", 
  httpsAgent !== httpAgent1 && httpsAgent.keepAlive === true
);

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
const total = results.length;
const passed = results.filter(r => r.status === "PASS").length;
const failed = results.filter(r => r.status === "FAIL").length;

console.log("\n==================================================================");
console.log(`  VERIFICATION RESULTS:  ${passed} Passed  |  ${failed} Failed  |  ${total} Total`);
console.log("==================================================================\n");

process.exit(failed > 0 ? 1 : 0);
