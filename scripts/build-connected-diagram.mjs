#!/usr/bin/env node
/**
 * MASTER VISUAL EXCALIDRAW ARCHITECTURE GENERATOR (HLD + LLD)
 * Builds a fully interconnected Excalidraw architectural diagram with:
 * - Real component nodes (styled containers, titles, LLD code/methods/formulas)
 * - Real directional connecting arrows (type: 'arrow') with labeled flows
 * - Updates all 13 legacy path strings in the base diagram to match current file tree
 * - Visualizes all 15 architectural hardening fixes and security isolation gates
 */

import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

function uid() {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

const diagramFile = 'docs/ninja-rp-new-diagram.excalidraw';
const raw = JSON.parse(readFileSync(diagramFile, 'utf8'));

// 1. EXTRACT & UPDATE BASE 156 ELEMENTS (Update legacy paths)
const base156 = raw.elements.slice(0, 156);
console.log(`Processing ${base156.length} base elements...`);

const PATH_REPLACEMENTS = [
  ['src/core/master.ts', 'src/core/cluster/master.ts'],
  ['src/core/worker.ts', 'src/core/cluster/worker.ts'],
  ['src/core/websocket.ts', 'src/core/proxy/websocket.handler.ts'],
  ['services/load-balancer.ts', 'src/balancer/core/load-balancer.ts'],
  ['middleware/cache.ts', 'src/cache/cache-manager.ts'],
  ['services/registry.ts', 'src/discovery/registry/dynamic.registry.ts'],
  ['services/health.ts', 'src/discovery/health/health.manager.ts'],
  ['services/metrics.ts', 'src/observability/metrics/prometheus.exporter.ts']
];

let replacedCount = 0;
base156.forEach((e) => {
  if (e.text) {
    PATH_REPLACEMENTS.forEach(([oldP, newP]) => {
      if (e.text.includes(oldP)) {
        e.text = e.text.split(oldP).join(newP);
        if (e.originalText) e.originalText = e.originalText.split(oldP).join(newP);
        replacedCount++;
      }
    });
  }
});
console.log(`Updated ${replacedCount} legacy path references in base diagram.`);

// 2. BUILD COMPONENT NODES & REAL ARROWS
const newElements = [];

function rect(x, y, w, h, bg = '#ffffff', stroke = '#1e1e1e', sw = 2, strokeStyle = 'solid') {
  const r = {
    id: uid(),
    type: 'rectangle',
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
    angle: 0,
    strokeColor: stroke,
    backgroundColor: bg,
    fillStyle: 'solid',
    strokeWidth: sw,
    strokeStyle,
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'b' + uid(),
    roundness: { type: 3 },
    seed: (Math.random() * 1e9) | 0,
    version: 1,
    versionNonce: (Math.random() * 1e9) | 0,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    created: null
  };
  newElements.push(r);
  return r;
}

function txt(x, y, content, color = '#1e1e1e', fontSize = 13, w = null, fontFamily = 3, align = 'left') {
  const lines = content.split('\n');
  const maxLen = Math.max(...lines.map((l) => l.length));
  const height = lines.length * (fontSize * 1.34) + 12;
  const width = w || Math.max(maxLen * (fontSize * 0.62), 150);
  const t = {
    id: uid(),
    type: 'text',
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    angle: 0,
    strokeColor: color,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'b' + uid(),
    roundness: null,
    seed: (Math.random() * 1e9) | 0,
    version: 1,
    versionNonce: (Math.random() * 1e9) | 0,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    created: null,
    text: content,
    fontSize,
    fontFamily,
    textAlign: align,
    verticalAlign: 'top',
    containerId: null,
    originalText: content,
    autoResize: true,
    lineHeight: 1.25
  };
  newElements.push(t);
  return t;
}

function compNode(x, y, w, h, title, body, bg = '#ffffff', stroke = '#1e1e1e', titleColor = '#1e1e1e') {
  const r = rect(x, y, w, h, bg, stroke, 2);
  txt(x + 14, y + 10, title, titleColor, 15, w - 28, 1);
  if (body) {
    txt(x + 14, y + 36, body, '#212529', 11, w - 28, 3);
  }
  return {
    id: r.id,
    x, y, w, h,
    top: { x: x + w / 2, y: y },
    bottom: { x: x + w / 2, y: y + h },
    left: { x: x, y: y + h / 2 },
    right: { x: x + w, y: y + h / 2 },
    center: { x: x + w / 2, y: y + h / 2 }
  };
}

function arrow(x1, y1, x2, y2, color = '#1971c2', label = '', strokeStyle = 'solid', sw = 2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const arr = {
    id: uid(),
    type: 'arrow',
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(Math.abs(dx)),
    height: Math.round(Math.abs(dy)),
    angle: 0,
    strokeColor: color,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: sw,
    strokeStyle,
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: (Math.random() * 1e9) | 0,
    version: 1,
    versionNonce: (Math.random() * 1e9) | 0,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    created: null,
    points: [
      [0, 0],
      [Math.round(dx), Math.round(dy)]
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    index: 'b' + uid()
  };
  newElements.push(arr);

  if (label) {
    const midX = x1 + dx * 0.5;
    const midY = y1 + dy * 0.5 - 12;
    const lbl = {
      id: uid(),
      type: 'text',
      x: Math.round(midX - (label.length * 6.5) / 2),
      y: Math.round(midY),
      width: Math.round(label.length * 7.5),
      height: 18,
      angle: 0,
      strokeColor: color,
      backgroundColor: '#ffffff',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: 'b' + uid(),
      roundness: null,
      seed: (Math.random() * 1e9) | 0,
      version: 1,
      versionNonce: (Math.random() * 1e9) | 0,
      isDeleted: false,
      boundElements: [],
      updated: Date.now(),
      link: null,
      locked: false,
      created: null,
      text: label,
      fontSize: 11,
      fontFamily: 3,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: null,
      originalText: label,
      autoResize: true,
      lineHeight: 1.2
    };
    newElements.push(lbl);
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: INGRESS & COMPLETE 8-STAGE MIDDLEWARE PIPELINE FLOW
// ═══════════════════════════════════════════════════════════════════════════════
const S1_Y = -2300;
rect(9440, S1_Y, 8200, 1150, '#e7f5ff', '#1971c2', 3);
txt(9470, S1_Y + 16, "⚡ FLOW 1: INGRESS, MASTER PROCESS & 8-STAGE MIDDLEWARE PIPELINE (src/core/pipeline/)", "#1971c2", 20, 8100, 1);

// Client Node
const nClient = compNode(9480, S1_Y + 70, 320, 130, "🖥️ CLIENT (Browser / API)", "Sends HTTP, HTTPS & WSS traffic\nHeader: Host, Authorization, Cookie\nx-canary, x-trace-id", "#ffffff", "#1971c2", "#1971c2");

// Ingress Ports
const nHttp8080 = compNode(9900, S1_Y + 70, 340, 130, "🚪 HTTP INGRESS (:8080)", "http.createServer(port: 8080)\n301 Moved Permanently -> HTTPS :8443\nListens for plain WS Upgrade events", "#ffffff", "#f08c00", "#d9480f");
const nHttps8443 = compNode(10340, S1_Y + 70, 380, 130, "🔒 HTTPS INGRESS (:8443)", "https.createServer(tlsOptions)\nTLS Termination (cert.pem + key.pem)\nMain request & WSS Upgrade handler", "#ffffff", "#2b8a3e", "#2b8a3e");

// Master Process Core
const nMaster = compNode(10820, S1_Y + 60, 640, 150, "👑 MASTER PROCESS (src/core/cluster/master.ts)", "• Normalizes workers=0 -> os.cpus().length (Fix #1)\n• Worker Lifecycle Supervisor (cluster.fork & auto-restart)\n• Creates RequestContext { req, res, clientIp, startTime }\n• Instantiates MiddlewarePipeline and executes pipeline.run(ctx)", "#ffffff", "#7048e8", "#5f3dc4");

// Middleware Pipeline Chain (Horizontal connected sequence)
const mY = S1_Y + 280;
const mW = 380;
const mH = 150;
const mGap = 40;
let mX = 9480;

const m1Tracing = compNode(mX, mY, mW, mH, "1. TRACING MIDDLEWARE", "src/middleware/tracing.middleware.ts\n• Extracts or generates X-Trace-Id (UUID)\n• Starts root span: tracer.startSpan()\n• Closes span in finally block", "#ffffff", "#1098ad", "#0c8599");
mX += mW + mGap;

const m2Cors = compNode(mX, mY, mW, mH, "2. CORS MIDDLEWARE", "src/middleware/cors.middleware.ts\n• Injects Access-Control-Allow-*\n• OPTIONS preflight -> returns 204 No Content\n• Allows credentials & custom headers", "#ffffff", "#1098ad", "#0c8599");
mX += mW + mGap;

const m3Body = compNode(mX, mY, mW, mH, "3. BODY LIMIT & STREAM SAFETY", "src/middleware/body-limit.middleware.ts\n• Validates Content-Length <= maxBytes\n• Stream Safety (Fix #13): chunks byte-counter\n  destroys req on overflow -> 413 Payload Too Large", "#ffffff", "#1098ad", "#0c8599");
mX += mW + mGap;

const m4Auth = compNode(mX, mY, mW, mH, "4. AUTH MIDDLEWARE", "src/middleware/auth.middleware.ts\n• Evaluates Authorization: Bearer <token>\n• Checks token in validTokens: Set<string>\n• On mismatch -> 401 Unauthorized", "#ffffff", "#1098ad", "#0c8599");
mX += mW + mGap;

const m5Rate = compNode(mX, mY, mW, mH, "5. RATE LIMIT MIDDLEWARE", "src/middleware/rate-limit.middleware.ts\n• Route-level (Fix #10, #11) & Global check\n• Evaluates isAllowed(clientIp)\n• On limit breach -> 429 + Retry-After header", "#ffffff", "#1098ad", "#0c8599");
mX += mW + mGap;

const m6Cache = compNode(mX, mY, mW, mH, "6. CACHE MIDDLEWARE", "src/middleware/cache.middleware.ts\n• If method === 'GET' -> buildKey(url)\n• L1 Memory / L2 Redis check\n• On HIT -> returns 200 + X-Cache: HIT", "#ffffff", "#1098ad", "#0c8599");
mX += mW + mGap;

const m7Route = compNode(mX, mY, 440, mH, "7. ROUTER & MATCHER", "src/core/router/route.matcher.ts\n• Longest prefix match against RouteRule[]\n• HTTP method filtering & stripPrefix\n• Normalizes upstreams (Fix #4, #5)", "#ffffff", "#e67700", "#d9480f");
mX += 440 + mGap;

const m8Isolation = compNode(mX, mY, 480, mH, "🛑 ROUTE ISOLATION GATE (Fix #2, #3)", "Strict Security Isolation:\n• Checks allowedUpstreams = route.upstreams\n• If route upstreams count === 0 healthy:\n  RETURNS 503 SERVICE UNAVAILABLE!\n• NEVER falls back to unrelated global upstreams!", "#fff5f5", "#c92a2a", "#c92a2a");

// Terminal endpoints of pipeline
const n503 = compNode(mX, S1_Y + 490, 480, 110, "⚠️ 503 ISOLATION REJECTION", "res.writeHead(503, {'Content-Type':'application/json'})\nres.end('{\"error\":\"No healthy upstreams for route\"}')\nPrevents routing payment traffic to transcoding/auth!", "#ffe3e3", "#e03131", "#c92a2a");

const nToLB = compNode(10820, S1_Y + 490, 640, 110, "➡️ PROCEED TO LOAD BALANCER", "lb.pickFiltered(routeHealthyUpstreams, clientIp, attempted, cookies)\nOnly candidates belonging to the matched route are dispatched!", "#ebfbee", "#2b8a3e", "#2b8a3e");

// ARROWS FOR SECTION 1
arrow(nClient.right.x, nClient.center.y, nHttp8080.left.x, nHttp8080.center.y, '#f08c00', 'Plain HTTP');
arrow(nClient.right.x, nClient.center.y, nHttps8443.left.x, nHttps8443.center.y, '#2b8a3e', 'HTTPS :8443');
arrow(nHttp8080.right.x, nHttp8080.center.y, nHttps8443.left.x, nHttps8443.center.y, '#f08c00', '301 Redirect');
arrow(nHttps8443.right.x, nHttps8443.center.y, nMaster.left.x, nMaster.center.y, '#2b8a3e', 'TLS Request');

arrow(nMaster.bottom.x, nMaster.bottom.y, m1Tracing.top.x, m1Tracing.top.y, '#1971c2', 'pipeline.run(ctx)');
arrow(m1Tracing.right.x, m1Tracing.center.y, m2Cors.left.x, m2Cors.center.y, '#1098ad', 'next()');
arrow(m2Cors.right.x, m2Cors.center.y, m3Body.left.x, m3Body.center.y, '#1098ad', 'next()');
arrow(m3Body.right.x, m3Body.center.y, m4Auth.left.x, m4Auth.center.y, '#1098ad', 'next()');
arrow(m4Auth.right.x, m4Auth.center.y, m5Rate.left.x, m5Rate.center.y, '#1098ad', 'next()');
arrow(m5Rate.right.x, m5Rate.center.y, m6Cache.left.x, m6Cache.center.y, '#1098ad', 'next()');
arrow(m6Cache.right.x, m6Cache.center.y, m7Route.left.x, m7Route.center.y, '#1098ad', 'Cache Miss -> next()');
arrow(m7Route.right.x, m7Route.center.y, m8Isolation.left.x, m8Isolation.center.y, '#e67700', 'Matched Rule');

arrow(m8Isolation.bottom.x, m8Isolation.bottom.y, n503.top.x, n503.top.y, '#c92a2a', '0 Healthy in Route -> REJECT 503');
arrow(m8Isolation.bottom.x, m8Isolation.bottom.y, nToLB.right.x, nToLB.center.y, '#2b8a3e', 'Healthy Upstreams Available');

console.log("Section 1 (Ingress & Pipeline Flow) built with real arrows.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: RATE LIMITING & HYBRID CACHING SUB-SYSTEMS
// ═══════════════════════════════════════════════════════════════════════════════
const S2_Y = S1_Y + 1220;
rect(9440, S2_Y, 8200, 1100, '#fff5f5', '#c92a2a', 3);
txt(9470, S2_Y + 16, "⏱️ FLOW 2: MULTI-ALGORITHM RATE LIMITING & HIGH-PERFORMANCE HYBRID CACHE (src/ratelimit/ & src/cache/)", "#c92a2a", 20, 8100, 1);

// Rate Limiter Subsystem (Left Column)
const nRL = compNode(9480, S2_Y + 70, 680, 150, "🎛️ RATE LIMITER CONTROLLER (src/ratelimit/rate-limiter.ts)", "• Evaluates isAllowed(ip) & getRemaining(ip)\n• SoftLimitPolicy: allows 1.5x burst when load < softLimit\n• Supports Memory, Redis, and Hybrid storage backends (Fix #9)\n• Injects Redis Lua scripts for atomic single-roundtrip execution", "#ffffff", "#c92a2a", "#c92a2a");

const nAlgos = compNode(9480, S2_Y + 280, 680, 220, "⚙️ ALL 5 RATE LIMIT ALGORITHMS", "1. Fixed Window: Map<key, {count, resetTime}> / Redis INCR + PEXPIRE\n2. Sliding Window Log: Map<key, timestamps[]> / Redis ZREMRANGEBYSCORE + ZADD\n3. Sliding Window Counter: Weighted estimate prev*(1-w) + curr / Redis Hashes\n4. Token Bucket: Continuous refill tokens + elapsed*rate / Redis Hashes\n5. Leaking Bucket: Constant drain level - elapsed*leakRate / Redis Hashes", "#ffffff", "#e03131", "#c92a2a");

const nRLStores = compNode(9480, S2_Y + 560, 680, 200, "💾 STORAGE BACKENDS & REDIS CLIENT (Fix #9)", "• MemoryStore: Local in-process Map (< 0.05ms)\n• RedisStore: Redis Cluster client (rlRedisClient)\n• HybridStore: Tiered L1 Memory fast-path + L2 async Redis sync\n  Fix #9: Creates Redis client for BOTH 'redis' and 'hybrid' storage!\n  Gracefully degrades to memory-only if Redis cluster is down.", "#ffffff", "#f03e3e", "#c92a2a");

// Caching Subsystem (Right Column)
const nCacheMgr = compNode(10240, S2_Y + 70, 720, 150, "🗃️ HYBRID CACHE MANAGER (src/cache/cache-manager.ts)", "• Tiered Dual-Layer Caching: L1 InMemoryLRU + L2 RedisCache\n• get(key): checks L1 -> on miss checks L2 -> populates L1 on hit\n• set(key, val, ttl): sets L1 immediately, sets L2 asynchronously\n• getStats(): reports L1 size/maxSize & L2 connectivity", "#ffffff", "#1976d2", "#1565c0");

const nCacheStores = compNode(10240, S2_Y + 280, 720, 200, "📦 CACHE STORES & RFC 7234 POLICIES", "• L1 InMemoryLRU: O(1) Map with LRU deletion and TTL expiration\n• L2 RedisCache: Redis client with EX expiration & KEYS pattern deletion\n• KeyBuilder: proxy:METHOD:path (strips query params, appends vary headers)\n• CacheControlParser: max-age, s-maxage, status whitelist (200, 301, 404, etc.)\n• StaleWhileRevalidate: serves stale cache while refreshing background\n• StaleIfError: serves stale response on 5xx upstream failure", "#ffffff", "#1565c0", "#0d47a1");

const nInvalidation = compNode(10240, S2_Y + 540, 720, 220, "⚡ CACHE INVALIDATION & CDC (src/cache/invalidation/)", "• TagInvalidator: Inverted index Map<tag, Set<key>> for entity group purge\n• PatternInvalidator: Wildcard glob regex conversion & Redis KEYS bulk DEL\n• Debezium CDC Invalidator: Consumes Kafka database change events (c,u,d,r)\n  Extracts record ID (SQL & Mongo ObjectId) -> substitutes {id} in pathPattern\n  Purges affected cache entries automatically upon DB mutations!", "#ffffff", "#0d47a1", "#0d47a1");

// ARROWS FOR SECTION 2
arrow(nRL.bottom.x, nRL.bottom.y, nAlgos.top.x, nAlgos.top.y, '#c92a2a', 'Selects configured algorithm');
arrow(nAlgos.bottom.x, nAlgos.bottom.y, nRLStores.top.x, nRLStores.top.y, '#c92a2a', 'Read / Write count');
arrow(nCacheMgr.bottom.x, nCacheMgr.bottom.y, nCacheStores.top.x, nCacheStores.top.y, '#1976d2', 'L1 -> L2 read-through');
arrow(nInvalidation.top.x, nInvalidation.top.y, nCacheStores.bottom.x, nCacheStores.bottom.y, '#0d47a1', 'CDC event -> cache.invalidate()');

console.log("Section 2 (Rate Limiter & Cache Flow) built with real arrows.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: LOAD BALANCER, RESILIENCE & WORKER DISPATCH
// ═══════════════════════════════════════════════════════════════════════════════
const S3_Y = S2_Y + 1160;
rect(9440, S3_Y, 8200, 1300, '#fff9db', '#e67700', 3);
txt(9470, S3_Y + 16, "⚖️ FLOW 3: LOAD BALANCER CORE, RESILIENCE SUITE & WORKER IPC EXECUTION", "#e67700", 20, 8100, 1);

// Load Balancer Core Node
const nLB = compNode(9480, S3_Y + 70, 720, 220, "⚖️ LOAD BALANCER CORE (src/balancer/core/load-balancer.ts)", "• pickFiltered(healthyIds, clientIp, attemptedIds, cookies):\n  1. Filters by routeHealthyUpstreams (strictly isolated!)\n  2. Excludes attemptedIds (prevents retry loop)\n  3. Checks circuitBreaker.isAllowed()\n  4. Prioritizes HALF_OPEN test canary probes\n  5. Checks activeConnections < maxConnections\n  6. Evaluates slowStart weight ramp-up for recovered nodes", "#ffffff", "#e67700", "#d9480f");

// Strategies Node
const nStrats = compNode(10260, S3_Y + 70, 760, 220, "🎯 ALL 12 LOAD BALANCING STRATEGIES", "• Round Robin / Weighted Round Robin (Nginx SWRR algorithm)\n• Adaptive WRR: weight * (1/(1+latency/100)) * (1 - errorRate)\n• Least Connections / Weighted Least Connections (activeConns / weight)\n• Least Response Time (min EWMA latency)\n• Power of Two Choices (P2C: picks 2 random, chooses min load)\n• Consistent Hashing: 150 virtual nodes per node, 32-bit FNV-1a ring\n• IP Hash / Sticky Sessions (NINJA_ROUTE) / Resource Based (cpu*0.7+mem*0.3)", "#ffffff", "#f08c00", "#d9480f");

// Resilience & Circuit Breaker Node
const nResilience = compNode(11080, S3_Y + 70, 760, 220, "🛡️ RESILIENCE & CIRCUIT BREAKERS (src/resilience/)", "• CircuitBreakerManager: Fix #8 clears on hot reload!\n• Classic Circuit Breaker: CLOSED -> OPEN (failures >= 3) -> HALF_OPEN (15s)\n• Adaptive Circuit Breaker: Google SRE p(drop) = max(0, (req - 2*acc)/(req+1))\n• SRE RetryBudget: Global 15% budget cap prevents retry storm cascading failure\n• 4 Backoffs: Exponential, Full Jitter, Equal Jitter, Decorrelated Jitter\n• Bulkhead: Limits max concurrent execution slots per upstream", "#ffffff", "#d6336c", "#c2255c");

// Master IPC Dispatcher
const nDispatcher = compNode(9480, S3_Y + 360, 720, 160, "📬 MASTER IPC DISPATCHER (src/core/cluster/master.ts)", "• Selects worker: workers[index++ % N]\n• Generates correlation UUID (requestId)\n• Stores pending replyHandler Map<requestId, { res, upstreamId, timer, attempted }>\n• Sets connectTimeoutMs (5s) and readTimeoutMs (30s) safety timers\n• Dispatches workerMessageSchema JSON payload over cluster IPC channel", "#ffffff", "#7048e8", "#5f3dc4");

// Worker Cluster Pool
const nWorkers = compNode(10260, S3_Y + 360, 760, 160, "👷 WORKER CLUSTER POOL (src/core/cluster/worker.ts)", "• Worker 1, Worker 2, Worker 3 (normalized from workers ?? os.cpus().length)\n• Persistent Connection Pools: httpAgent & httpsAgent (maxSockets: 256, keepAlive: 10s)\n• Request Header Sanitization: strips hop-by-hop, Host rewrite, X-Forwarded-*\n• Upstream HTTP/HTTPS streaming execution via transport.request()\n• Response Decompression (zlib.gunzip) & Client Negotiation (zlib.gzip)", "#ffffff", "#2b8a3e", "#2b8a3e");

// Upstream Backends
const nBackends = compNode(11080, S3_Y + 360, 760, 160, "🏢 UPSTREAM BACKEND POOL", "• Backend A (http://backend-a:3001) [Weight: 1, MaxConns: 500]\n• Backend B (http://backend-b:3002) [Weight: 2, MaxConns: 500]\n• Backend C (https://backend-c:3003) [Weight: 1, TLS + Custom CA]\nProcesses actual microservice business logic & returns response stream", "#ffffff", "#1971c2", "#1864ab");

// Fault Recovery & Retry Loop
const nRetryLoop = compNode(10260, S3_Y + 580, 760, 140, "🔁 FAULT RECOVERY & RETRY LOOP (StatusCodes: 502, 503, 504)", "1. On upstream network error or 5xx: lb.recordFailure(id)\n2. Checks globalRetryBudget.recordRetry() -> if ratio <= 15%:\n3. attemptedIds.add(failedId) -> Re-enters lb.pickFiltered() for NEXT candidate!\n4. Transparently retries request up to maxAttempts (default: 2 or 4)\n5. If all retries exhausted: returns 502 Bad Gateway to client.", "#fff5f5", "#c92a2a", "#c92a2a");

// ARROWS FOR SECTION 3
arrow(nLB.right.x, nLB.center.y, nStrats.left.x, nStrats.center.y, '#e67700', 'pick(candidates)');
arrow(nLB.right.x, nLB.center.y + 40, nResilience.left.x, nResilience.center.y + 40, '#d6336c', 'isAllowed() & SRE ratio');
arrow(nLB.bottom.x, nLB.bottom.y, nDispatcher.top.x, nDispatcher.top.y, '#7048e8', 'Selected upstreamId');

arrow(nDispatcher.right.x, nDispatcher.center.y, nWorkers.left.x, nWorkers.center.y, '#7048e8', 'process.send(WorkerMessageType)');
arrow(nWorkers.right.x, nWorkers.center.y, nBackends.left.x, nBackends.center.y, '#2b8a3e', 'Pooled HTTP/HTTPS Stream');
arrow(nBackends.left.x, nBackends.center.y + 40, nWorkers.right.x, nWorkers.center.y + 40, '#2b8a3e', 'Response Chunks');
arrow(nWorkers.left.x, nWorkers.center.y + 40, nDispatcher.right.x, nDispatcher.center.y + 40, '#7048e8', 'WorkerReplyMessageType');

arrow(nDispatcher.bottom.x, nDispatcher.bottom.y, nRetryLoop.top.x, nRetryLoop.center.y, '#c92a2a', 'On 502/503/504 Failure');
arrow(nRetryLoop.left.x, nRetryLoop.center.y, nLB.bottom.x, nLB.bottom.y, '#c92a2a', 'Retry with alternate candidate');

console.log("Section 3 (Load Balancer & Worker Flow) built with real arrows.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: WEBSOCKET UPGRADE, SERVICE DISCOVERY & DUAL-MODE HEALTH PROBES
// ═══════════════════════════════════════════════════════════════════════════════
const S4_Y = S3_Y + 1360;
rect(9440, S4_Y, 8200, 1150, '#c5f6fa', '#0c8599', 3);
txt(9470, S4_Y + 16, "🌐 FLOW 4: WEBSOCKET DIRECT TUNNEL, DYNAMIC DISCOVERY & DUAL-MODE HEALTH PROBES", "#0c8599", 20, 8100, 1);

// WebSocket Upgrade Flow
const nWsFlow = compNode(9480, S4_Y + 70, 720, 220, "🔌 WEBSOCKET DIRECT TUNNEL (src/core/proxy/websocket.handler.ts)", "• HTTP 'upgrade' event intercepted by Master\n• Fix #3: Route isolation enforced (destroys socket if route upstreams = 0)\n• Protocol resolution: if wss/https -> tls.connect; else -> net.connect\n• Fix #14: Passes tlsConfig with CA buffer on fallback tunneling\n• Full Duplex Pipe: clientSocket.pipe(target) <-> target.pipe(clientSocket)\n• Zero protocol overhead; sub-microsecond binary frame streaming!", "#ffffff", "#0c8599", "#0c8599");

// Service Registry Node
const nRegistry = compNode(10260, S4_Y + 70, 760, 220, "📋 DYNAMIC SERVICE REGISTRY (src/discovery/registry/dynamic.registry.ts)", "• REST API: POST /__registry/register & PUT /__registry/heartbeat/:id\n• In-memory Map<id, ServiceInstance> with UP/DOWN state\n• Background GC: checkHeartbeats() evicts services after 30s timeout\n• Atomic Persistence: Writes temporary file -> atomic POSIX rename\n  proxy_registry_backup.json (survives proxy crashes and restarts!)\n• Event callbacks: onRegister & onDeregister notify LoadBalancer", "#ffffff", "#0c8599", "#087f5b");

// Dual-Mode Health Probing Subsystem
const nHealthMgr = compNode(11080, S4_Y + 70, 760, 220, "❤ DUAL-MODE HEALTH PROBING SUBSYSTEM (src/discovery/health/)", "ACTIVE PROBING (active.probe.ts):\n• checkUpstream(): HTTP/HTTPS GET to /health every 10s (5s timeout)\n• Custom CA support & TLS verification; sets status in HEALTHY_UPSTREAMS\n\nPASSIVE PROBING (passive.probe.ts & health.manager.ts):\n• Observes live user traffic responses in real-time\n• 5 errors (>= 500) in 30s sliding window -> trips upstream DOWN passively!\n• Single 200 OK -> immediately revives upstream UP passively!\n• Fix #6: Mutable getter keeps listener bound to active LB across reloads!", "#ffffff", "#087f5b", "#087f5b");

// ARROWS FOR SECTION 4
arrow(nWsFlow.right.x, nWsFlow.center.y, nBackends.bottom.x, nBackends.bottom.y, '#0c8599', 'Direct TCP/TLS Duplex Tunnel');
arrow(nRegistry.right.x, nRegistry.center.y, nHealthMgr.left.x, nHealthMgr.center.y, '#087f5b', 'Notifies registered upstreams');
arrow(nHealthMgr.left.x, nHealthMgr.center.y + 40, nLB.bottom.x, nLB.bottom.y, '#087f5b', 'Mutates lb.setHealthy(id, state)');

console.log("Section 4 (WebSocket, Registry & Probes) built with real arrows.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: OBSERVABILITY, ADMIN CONTROL PLANE & HOT-RELOAD SAFE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const S5_Y = S4_Y + 1210;
rect(9440, S5_Y, 8200, 1150, '#f3f0ff', '#5f3dc4', 3);
txt(9470, S5_Y + 16, "📊 FLOW 5: OBSERVABILITY (PROMETHEUS/GRAFANA), CONFIG ENGINE & HOT RELOAD", "#5f3dc4", 20, 8100, 1);

// Observability Core
const nObs = compNode(9480, S5_Y + 70, 720, 220, "📊 OBSERVABILITY ENGINE (src/observability/)", "• MetricsRegistry: Counters (requests, errors) & Gauges (active connections, CPU, RAM)\n• HistogramRegistry: 10 latency buckets (5ms to 5000ms)\n• Cluster Snapshot Aggregation: Master polls workers over IPC & merges snapshots\n• Distributed Tracer: Generates and propagates X-Trace-Id across spans\n• TenantLogStreamer: 10k tenant queue, 1s batch flush over HTTP POST webhooks\n• ReadinessProbe (Fix #7): Deduplicates by name and supports clear() on reload", "#ffffff", "#5f3dc4", "#5f3dc4");

// Admin API Control Plane
const nAdmin = compNode(10260, S5_Y + 70, 760, 220, "🕹️ ADMIN API CONTROL PLANE (src/core/admin/admin.handler.ts)", "• Fix #12: Supports both root paths and configured admin.pathPrefix (/__admin/*)\n• GET /__lb-stats: Real-time upstream active connections, EWMA latency, CB states\n• GET /metrics & /__metrics: Cluster-wide Prometheus text exposition (version 0.0.4)\n• GET /__registry: Dynamic service discovery instance statuses\n• GET /__ready & /__health: Subsystem readiness checks (Redis, Upstreams)\n• GET /__cache-stats: L1 memory and L2 Redis hit/miss counters", "#ffffff", "#6741d9", "#5f3dc4");

// Config Loader & Hot Reload Subsystem
const nHotReload = compNode(11080, S5_Y + 70, 760, 220, "🔄 CONFIG ENGINE & HOT RELOAD (src/config/config.loader.ts)", "• parseYAMLConfig: Parses config.yaml & merges config.d/*.yaml in parallel\n• Inotify Watchers: fs.watch on config.yaml & config.d/ with 100ms debounce\n• SIGHUP Signal Handler: Triggers zero-downtime hot reload\n• reloadServerConfig() Safety Rebuild:\n  1. Fix #8: Calls circuitBreakerManager.clear() to discard stale breakers\n  2. Fix #7: Calls readinessProbe.clear() to prevent duplicate checks\n  3. Rebuilds LoadBalancer, Cache, and RateLimiters with full parity (Fix #10, #11)\n  4. Forks new workers and sends GRACEFUL_SHUTDOWN to old workers!", "#ffffff", "#2b8a3e", "#2b8a3e");

// ARROWS FOR SECTION 5
arrow(nObs.right.x, nObs.center.y, nAdmin.left.x, nAdmin.center.y, '#5f3dc4', 'Emits aggregated metrics');
arrow(nHotReload.left.x, nHotReload.center.y, nAdmin.right.x, nAdmin.center.y, '#2b8a3e', 'Hot-reload reconfigures subsystems');

console.log("Section 5 (Observability & Hot Reload) built with real arrows.");

// 3. COMMIT ALL ELEMENTS (Base 156 with updated paths + All newly constructed nodes & arrows)
raw.elements = [...base156, ...newElements];
writeFileSync(diagramFile, JSON.stringify(raw, null, 2));

const arrowCount = raw.elements.filter(e => e.type === 'arrow').length;
const rectCount = raw.elements.filter(e => e.type === 'rectangle').length;
const textCount = raw.elements.filter(e => e.type === 'text').length;

console.log(`\n========================================================================`);
console.log(`🎉 FULLY INTERCONNECTED EXCALIDRAW ARCHITECTURE DIAGRAM GENERATED!`);
console.log(`========================================================================`);
console.log(`• Base Elements Preserved & Path-Corrected: ${base156.length}`);
console.log(`• New Component Nodes, Rectangles & Arrows: ${newElements.length}`);
console.log(`• Total Diagram Elements: ${raw.elements.length}`);
console.log(`  - Rectangles: ${rectCount}`);
console.log(`  - Directional Arrows (with Flow Labels): ${arrowCount}`);
console.log(`  - Text Blocks: ${textCount}`);
console.log(`• Output File: ${diagramFile}`);
console.log(`• File Size: ${(Buffer.byteLength(JSON.stringify(raw)) / 1024).toFixed(1)} KB`);
console.log(`========================================================================\n`);

