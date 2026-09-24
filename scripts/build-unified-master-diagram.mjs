#!/usr/bin/env node
/**
 * MASTER VISUAL EXCALIDRAW ARCHITECTURE GENERATOR (HLD + LLD UNIFIED & ARCHITECTURALLY ALIGNED)
 * 
 * Generates an exhaustive, 100% interconnected, visually balanced Excalidraw architecture diagram:
 * 1. Preserves and modernizes all 156 base HLD architecture elements (correcting all legacy paths).
 * 2. Unifies HLD and LLD under a single cohesive outer container (CANVAS_W: 10600, Y: -8860 to +3350).
 * 3. Builds a dedicated Gateway Bridge Dispatcher Bar connecting HLD directly into LLD flows.
 * 4. Implements all 5 deep LLD subsystem flows with clean spatial routing (zero cross-canvas diagonals):
 *    - Flow 1: 8-Stage Sequential Middleware Pipeline & Route Isolation Gate (Fix #2, #3, #13)
 *    - Flow 2: Multi-Algorithm Rate Limiting (5 algorithms, hybrid store Fix #9) & Tiered Cache (L1 LRU, L2 Redis, CDC)
 *    - Flow 3: Load Balancer Core (12 strategies, SRE CB Fix #8, retry budget 15%) & Worker Cluster IPC Pool
 *    - Flow 4: WebSocket Duplex Tunnel (Fix #3, #14), Dynamic Registry (atomic backup) & Dual-Mode Health Probing (Fix #6)
 *    - Flow 5: Full Observability Suite (Prometheus, Grafana, LogStreamer) & Zero-Downtime Hot Reload (Fix #7, #8, #10, #11, #12)
 * 5. Wires EVERY component with real directional arrows, labeled data flows, and zero orphan blocks.
 */

import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

function uid() {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

const diagramFile = 'docs/ninja-rp-new-diagram.excalidraw';
const raw = JSON.parse(readFileSync(diagramFile, 'utf8'));

// 1. EXTRACT & UPDATE BASE 156 ELEMENTS
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
  ['services/metrics.ts', 'src/observability/metrics/prometheus.exporter.ts'],
  ['src/src/balancer', 'src/balancer']
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

// Master outer container
const outerContainer = base156.find(e => e.id === 'eiyzKu77YclanSq3CehTp');

// 2. ELEMENT BUILDERS
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
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    top: { x: Math.round(x + w / 2), y: Math.round(y) },
    bottom: { x: Math.round(x + w / 2), y: Math.round(y + h) },
    left: { x: Math.round(x), y: Math.round(y + h / 2) },
    right: { x: Math.round(x + w), y: Math.round(y + h / 2) },
    center: { x: Math.round(x + w / 2), y: Math.round(y + h / 2) }
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
// MASTER CANVAS DIMENSIONS (Width: 10600px from X: 9480 to 20080)
// ═══════════════════════════════════════════════════════════════════════════════
const CANVAS_X = 9480;
const CANVAS_W = 10600;

// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY BRIDGE DISPATCHER BAR (Directly below Key Notes, bridging HLD to LLD)
// ═══════════════════════════════════════════════════════════════════════════════
const BANNER_Y = -2180;
rect(CANVAS_X, BANNER_Y, CANVAS_W, 90, '#e7f5ff', '#1971c2', 3);
txt(CANVAS_X + 24, BANNER_Y + 12, "🔬 DEEP LOW-LEVEL DESIGN (LLD): ARCHITECTURAL ENGINES, RUNTIME PIPELINES & HARDENED DATA FLOWS", "#1971c2", 20, CANVAS_W - 48, 1, 'center');
txt(CANVAS_X + 24, BANNER_Y + 46, "All 15 Architectural Hardening Fixes  |  Route-Scoped Upstream Isolation  |  Zero-Downtime Safe Hot Reload  |  Dual-Mode Probing  |  100% Test Parity", "#495057", 13, CANVAS_W - 48, 3, 'center');

// 5 Gateway Portals across the bridge
const portalW = 1960;
const portalGap = 160;
let pX = CANVAS_X + 60;
const portalY = BANNER_Y + 110;

const p1 = compNode(pX, portalY, portalW, 70, "⚡ LLD GATE 1: PIPELINE", "Ingress -> 8 Middleware Stages -> Route Isolation", "#f8f9fa", "#1971c2", "#1971c2");
pX += portalW + portalGap;

const p2 = compNode(pX, portalY, portalW, 70, "⏱️ LLD GATE 2: RATE & CACHE", "5 Algorithms -> Hybrid Store -> L1/L2 -> CDC", "#fff5f5", "#c92a2a", "#c92a2a");
pX += portalW + portalGap;

const p3 = compNode(pX, portalY, portalW, 70, "⚖️ LLD GATE 3: LB & WORKERS", "12 Strategies -> SRE CB -> IPC -> Transport Pool", "#fff9db", "#e67700", "#e67700");
pX += portalW + portalGap;

const p4 = compNode(pX, portalY, portalW, 70, "🌐 LLD GATE 4: WS & REGISTRY", "Duplex Tunnel -> Active Probes -> Passive Traffic", "#c5f6fa", "#0c8599", "#0c8599");
pX += portalW + portalGap;

const p5 = compNode(pX, portalY, portalW, 70, "📊 LLD GATE 5: OBS & RELOAD", "Prometheus -> Metrics -> Admin API -> Hot Reload", "#f3f0ff", "#5f3dc4", "#5f3dc4");

// Wire Bridge Arrows from Base HLD components to Gateway Portals
arrow(11500, -2220, p1.top.x, p1.top.y, '#1971c2', 'Ingress Pipeline Dispatch', 'solid', 2);
arrow(13500, -2220, p2.top.x, p2.top.y, '#c92a2a', 'Rate & Cache Subsystems', 'solid', 2);
arrow(15500, -2220, p3.top.x, p3.top.y, '#e67700', 'Load Balancing & Resilience', 'solid', 2);
arrow(17500, -2220, p4.top.x, p4.top.y, '#0c8599', 'WS Tunnel & Dynamic Discovery', 'solid', 2);
arrow(19000, -2220, p5.top.x, p5.top.y, '#5f3dc4', 'Observability & Hot Reload Rebuild', 'solid', 2);

console.log("Gateway Bridge Dispatcher Bar successfully created.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: 8-STAGE MIDDLEWARE PIPELINE & ROUTE ISOLATION GATE (LLD Flow 1)
// ═══════════════════════════════════════════════════════════════════════════════
const S1_Y = -1960;
rect(CANVAS_X, S1_Y, CANVAS_W, 920, '#f8f9fa', '#1971c2', 2);
txt(CANVAS_X + 24, S1_Y + 16, "⚡ LLD FLOW 1: REQUEST INGRESS DISPATCH & 8-STAGE MIDDLEWARE PIPELINE (src/core/pipeline/)", "#1971c2", 18, CANVAS_W - 48, 1);

// Top Context Row
const nCtx = compNode(CANVAS_X + 40, S1_Y + 55, 3300, 160, "📥 REQUEST CONTEXT INIT (src/core/cluster/master.ts)", "• Normalizes workers=0 -> os.cpus().length (Fix #1)\n• Captures: req, res, clientIp, startTime, URL pathname\n• Instantiates RequestContext object and starts MiddlewarePipeline\n• Executes pipeline.run(ctx) with asynchronous error boundary", "#ffffff", "#7048e8", "#5f3dc4");

const nMatcherHeader = compNode(CANVAS_X + 3500, S1_Y + 55, 3400, 160, "🔍 ROUTE MATCHER & NORMALIZATION (src/core/router/route.matcher.ts)", "• Longest prefix match on RouteRule[] with path stripping\n• HTTP method filtering & custom header matching\n• Canonical route normalization: route.upstreams unified shape (Fix #4, #5)\n• Attaches matched pathRule and route-scoped allowed upstream IDs to context", "#ffffff", "#e67700", "#d9480f");

const nGateHeader = compNode(CANVAS_X + 7060, S1_Y + 55, 3480, 160, "🛑 ROUTE-SCOPED UPSTREAM ISOLATION GATE (Fix #2, #3)", "• Strict Security Isolation Rule:\n  Evaluates routeHealthyUpstreams = matchedRoute.upstreams.filter(isHealthy)\n• If routeHealthyUpstreams.length === 0:\n  RETURNS 503 SERVICE UNAVAILABLE! (NEVER falls back to global upstreams!)\n• Guarantees total tenant isolation (prevents payment traffic reaching auth/media)", "#fff5f5", "#c92a2a", "#c92a2a");

arrow(p1.bottom.x, p1.bottom.y, nCtx.top.x, nCtx.top.y, '#1971c2', 'Dispatches to Pipeline Entry');

// 8 Sequential Pipeline Stages (Full Width Row)
const sW = 1180;
const sGap = 145;
let sX = CANVAS_X + 40;
const sY = S1_Y + 260;
const sH = 175;

const m1 = compNode(sX, sY, sW, sH, "STAGE 1: TRACING", "src/middleware/tracing.middleware.ts\n• Extracts or creates X-Trace-Id\n• tracer.startSpan('proxy-request')\n• Injects trace header to response\n• Span.end() in finally block", "#ffffff", "#1098ad", "#0c8599");
sX += sW + sGap;

const m2 = compNode(sX, sY, sW, sH, "STAGE 2: CORS", "src/middleware/cors.middleware.ts\n• Origin & methods validation\n• Access-Control-Allow-*\n• OPTIONS preflight -> returns 204\n• Enables credentials flag", "#ffffff", "#1098ad", "#0c8599");
sX += sW + sGap;

const m3 = compNode(sX, sY, sW, sH, "STAGE 3: BODY SAFETY", "src/middleware/body-limit.middleware.ts\n• Content-Length header limit\n• Stream Safety (Fix #13): chunks\n  byte-counter destroys req -> 413\n• Prevents heap memory DOS", "#ffffff", "#1098ad", "#0c8599");
sX += sW + sGap;

const m4 = compNode(sX, sY, sW, sH, "STAGE 4: AUTH", "src/middleware/auth.middleware.ts\n• Authorization: Bearer <token>\n• Checks validTokens: Set<string>\n• Missing/invalid token -> 401\n• Attaches user auth context", "#ffffff", "#1098ad", "#0c8599");
sX += sW + sGap;

const m5 = compNode(sX, sY, sW, sH, "STAGE 5: RATE LIMIT", "src/middleware/rate-limit.middleware.ts\n• Route-level (Fix #10, #11) & global\n• Evaluates isAllowed(clientIp)\n• Limit breached -> 429 + Retry-After\n• Injects X-RateLimit-* headers", "#ffffff", "#c92a2a", "#c92a2a");
sX += sW + sGap;

const m6 = compNode(sX, sY, sW, sH, "STAGE 6: CACHE", "src/middleware/cache.middleware.ts\n• If method === 'GET' -> buildKey()\n• L1 Memory / L2 Redis check\n• HIT -> returns 200 + X-Cache: HIT\n• MISS -> proceeds to router", "#ffffff", "#1976d2", "#1565c0");
sX += sW + sGap;

const m7 = compNode(sX, sY, sW, sH, "STAGE 7: ROUTER", "src/core/router/route.matcher.ts\n• Longest prefix match\n• Path rewrite / stripPrefix\n• Canonical upstream array\n• Attaches route config to ctx", "#ffffff", "#e67700", "#d9480f");
sX += sW + sGap;

const m8 = compNode(sX, sY, sW, sH, "STAGE 8: ISOLATION", "src/core/cluster/master.ts\n• Route isolation gate\n• 0 healthy in route -> 503 error\n• >=1 healthy -> pickFiltered()\n• Strictly isolated route scope!", "#fff5f5", "#c92a2a", "#c92a2a");

// Stage 8 Terminal Branches Row
const n503 = compNode(CANVAS_X + 7060, S1_Y + 480, 1600, 150, "⚠️ 503 ROUTE REJECTION", "res.writeHead(503, {'Content-Type':'application/json'})\nres.end('{\"error\":\"No healthy upstreams for route\"}')\nPrevents accidental fallback to wrong microservices!", "#ffe3e3", "#e03131", "#c92a2a");

const nToLB = compNode(CANVAS_X + 8800, S1_Y + 480, 1740, 150, "➡️ PROCEED TO LOAD BALANCER", "lb.pickFiltered(routeHealthyUpstreams, clientIp, attemptedIds, cookies)\nOnly candidates strictly belonging to matched route are dispatched!", "#ebfbee", "#2b8a3e", "#2b8a3e");

// Wire Flow 1 Arrows
arrow(nCtx.bottom.x, nCtx.bottom.y, m1.top.x, m1.top.y, '#1971c2', 'pipeline.run(ctx)');
arrow(m1.right.x, m1.center.y, m2.left.x, m2.center.y, '#1098ad', 'next()');
arrow(m2.right.x, m2.center.y, m3.left.x, m3.center.y, '#1098ad', 'next()');
arrow(m3.right.x, m3.center.y, m4.left.x, m4.center.y, '#1098ad', 'next()');
arrow(m4.right.x, m4.center.y, m5.left.x, m5.center.y, '#1098ad', 'next()');
arrow(m5.right.x, m5.center.y, m6.left.x, m6.center.y, '#1098ad', 'next()');
arrow(m6.right.x, m6.center.y, m7.left.x, m7.center.y, '#1098ad', 'Miss -> next()');
arrow(m7.right.x, m7.center.y, m8.left.x, m8.center.y, '#e67700', 'Matched');

arrow(m8.bottom.x, m8.bottom.y, n503.top.x, n503.top.y, '#c92a2a', '0 Healthy -> 503');
arrow(m8.bottom.x, m8.bottom.y, nToLB.top.x, nToLB.top.y, '#2b8a3e', 'Healthy Available');

console.log("Flow 1 constructed with full stage width balance.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: MULTI-ALGORITHM RATE LIMITING & TIERED HYBRID CACHE (LLD Flow 2)
// ═══════════════════════════════════════════════════════════════════════════════
const S2_Y = S1_Y + 970;
rect(CANVAS_X, S2_Y, CANVAS_W, 1020, '#fff5f5', '#c92a2a', 2);
txt(CANVAS_X + 24, S2_Y + 16, "⏱️ LLD FLOW 2: MULTI-ALGORITHM RATE LIMITING & HIGH-PERFORMANCE HYBRID CACHE (src/ratelimit/ & src/cache/)", "#c92a2a", 18, CANVAS_W - 48, 1);

// Connecting Gateway Portal 2 down to Flow 2
arrow(p2.bottom.x, p2.bottom.y, CANVAS_X + 2600, S2_Y, '#c92a2a', 'Rate & Cache Subsystems');

// Left Half: Rate Limiter Subsystem (X: 9520 to 14660, width: 5140)
const nRL = compNode(CANVAS_X + 40, S2_Y + 55, 5140, 160, "🎛️ RATE LIMITER CONTROLLER (src/ratelimit/rate-limiter.ts)", "• Evaluates isAllowed(ip, routeConfig) & getRemaining(ip)\n• SoftLimitPolicy: allows 1.5x burst when current load < softLimit threshold\n• Supports Memory, Redis, and Hybrid storage backends (Fix #9)\n• Injects Redis Lua scripts for atomic single-roundtrip execution without race conditions", "#ffffff", "#c92a2a", "#c92a2a");

const nAlgos = compNode(CANVAS_X + 40, S2_Y + 255, 5140, 240, "⚙️ ALL 5 RATE LIMITING ALGORITHMS (src/ratelimit/algorithms/)", "1. Fixed Window: Map<key, {count, resetTime}> / Redis INCR + PEXPIRE\n2. Sliding Window Log: Map<key, timestamps[]> / Redis ZREMRANGEBYSCORE + ZADD\n3. Sliding Window Counter: Weighted estimate prev*(1-w) + curr / Redis Hashes\n4. Token Bucket: Continuous refill tokens + elapsed*rate / Redis Hashes\n5. Leaking Bucket: Constant drain level - elapsed*leakRate / Redis Hashes\nAll implement IRateLimitAlgorithm interface with exact TTL atomicity and clock skew tolerance.", "#ffffff", "#e03131", "#c92a2a");

const nRLStores = compNode(CANVAS_X + 40, S2_Y + 535, 5140, 220, "💾 STORAGE BACKENDS & REDIS CLUSTER INTEGRATION (Fix #9)", "• MemoryStore: Local in-process Map (< 0.05ms fast-path)\n• RedisStore: Redis Cluster client with connection pooling (rlRedisClient)\n• HybridStore: Tiered L1 Memory fast-path + L2 async Redis sync\n  Fix #9: Initializes Redis client for BOTH 'redis' AND 'hybrid' storage!\n  Gracefully degrades to memory-only if Redis cluster is temporarily unreachable.", "#ffffff", "#f03e3e", "#c92a2a");

// Right Half: Hybrid Caching & Invalidation Subsystem (X: 14820 to 20040, width: 5220)
const nCacheMgr = compNode(CANVAS_X + 5340, S2_Y + 55, 5200, 160, "🗃️ HYBRID CACHE MANAGER (src/cache/cache-manager.ts)", "• Tiered Dual-Layer Caching: L1 InMemoryLRU + L2 RedisCache\n• get(key): checks L1 -> on miss checks L2 -> populates L1 on hit\n• set(key, val, ttl): sets L1 immediately, sets L2 asynchronously\n• getStats(): reports L1 size/maxSize, hit/miss ratios & L2 connectivity status", "#ffffff", "#1976d2", "#1565c0");

const nCacheStores = compNode(CANVAS_X + 5340, S2_Y + 255, 5200, 240, "📦 CACHE STORES & RFC 7234 POLICIES (src/cache/policies/)", "• L1 InMemoryLRU: O(1) Map with LRU deletion and TTL expiration\n• L2 RedisCache: Redis client with EX expiration & KEYS pattern deletion\n• KeyBuilder: proxy:METHOD:path (strips query params, appends vary headers)\n• CacheControlParser: max-age, s-maxage, status whitelist (200, 301, 404)\n• StaleWhileRevalidate: serves stale cache while refreshing upstream asynchronously\n• StaleIfError: serves stale cached response on 5xx upstream failure", "#ffffff", "#1565c0", "#0d47a1");

const nInvalidation = compNode(CANVAS_X + 5340, S2_Y + 535, 5200, 220, "⚡ CACHE INVALIDATION & DEBEZIUM CDC (src/cache/invalidation/)", "• TagInvalidator: Inverted index Map<tag, Set<key>> for entity group purge\n• PatternInvalidator: Wildcard glob regex conversion & Redis KEYS bulk DEL\n• Debezium CDC Invalidator: Consumes Kafka database change events (c,u,d,r)\n  Extracts record ID (SQL & Mongo ObjectId) -> substitutes {id} in pathPattern\n  Purges affected cache entries automatically upon DB mutations!", "#ffffff", "#0d47a1", "#0d47a1");

// Internal Arrows in Flow 2
arrow(nRL.bottom.x, nRL.bottom.y, nAlgos.top.x, nAlgos.top.y, '#c92a2a', 'Selects configured algorithm');
arrow(nAlgos.bottom.x, nAlgos.bottom.y, nRLStores.top.x, nRLStores.top.y, '#c92a2a', 'Read / Write count');
arrow(nCacheMgr.bottom.x, nCacheMgr.bottom.y, nCacheStores.top.x, nCacheStores.top.y, '#1976d2', 'L1 -> L2 read-through');
arrow(nInvalidation.bottom.x, nInvalidation.bottom.y, nCacheStores.bottom.x, nCacheStores.bottom.y, '#0d47a1', 'CDC event -> cache.invalidate()');

// Cross-Flow Arrows from Flow 1 to Flow 2
arrow(m5.bottom.x, m5.bottom.y, nRL.top.x, nRL.top.y, '#c92a2a', 'isAllowed(clientIp) check');
arrow(m6.bottom.x, m6.bottom.y, nCacheMgr.top.x, nCacheMgr.top.y, '#1976d2', 'get(key) / set(key, val, ttl)');

// Lateral arrow connecting RateLimiter RedisStore to Cache L2 Redis
arrow(nRLStores.right.x, nRLStores.center.y, nCacheStores.left.x, nCacheStores.center.y, '#c92a2a', 'Shared Redis Cluster Connection');

console.log("Flow 2 constructed with rate limiting & cache cross-wiring.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: LOAD BALANCER CORE, RESILIENCE SUITE & WORKER CLUSTER IPC (Flow 3)
// ═══════════════════════════════════════════════════════════════════════════════
const S3_Y = S2_Y + 1070;
rect(CANVAS_X, S3_Y, CANVAS_W, 1140, '#fff9db', '#e67700', 2);
txt(CANVAS_X + 24, S3_Y + 16, "⚖️ LLD FLOW 3: LOAD BALANCER CORE, RESILIENCE SUITE & WORKER IPC CLUSTER (src/balancer/ & src/resilience/)", "#e67700", 18, CANVAS_W - 48, 1);

// Connecting Gateway Portal 3 down to Flow 3
arrow(p3.bottom.x, p3.bottom.y, CANVAS_X + 5200, S3_Y, '#e67700', 'Load Balancing & Resilience');

// 3 Balanced Columns across 10600px width
const colW = 3400;
const colGap = 130;
const c1X = CANVAS_X + 40;
const c2X = c1X + colW + colGap;
const c3X = c2X + colW + colGap;

// Column 1: Load Balancer Core & Master IPC Dispatcher
const nLB = compNode(c1X, S3_Y + 55, colW, 280, "⚖️ LOAD BALANCER CORE (src/balancer/core/load-balancer.ts)", "• pickFiltered(healthyIds, clientIp, attemptedIds, cookies):\n  1. Filters by routeHealthyUpstreams (strictly isolated!)\n  2. Excludes attemptedIds (prevents retry loops)\n  3. Checks circuitBreaker.isAllowed()\n  4. Prioritizes HALF_OPEN test canary probes\n  5. Checks activeConnections < maxConnections\n  6. Evaluates slowStart weight ramp-up for recovered nodes\n• Mutates activeConnections & EWMA response latency metrics", "#ffffff", "#e67700", "#d9480f");

const nDispatcher = compNode(c1X, S3_Y + 375, colW, 280, "📬 MASTER IPC DISPATCHER (src/core/cluster/master.ts)", "• Selects worker: workers[index++ % N] round-robin\n• Generates correlation UUID (requestId)\n• Stores pending replyHandler Map<requestId, { res, upstreamId, timer, attempted }>\n• Sets connectTimeoutMs (5s) and readTimeoutMs (30s) safety timers\n• Dispatches workerMessageSchema JSON payload over Node cluster IPC channel", "#ffffff", "#7048e8", "#5f3dc4");

const nRetryLoop = compNode(c1X, S3_Y + 695, colW, 200, "🔁 FAULT RECOVERY & SRE RETRY LOOP", "1. On upstream network error or 502/503/504: lb.recordFailure(id)\n2. Checks globalRetryBudget.recordRetry() -> if ratio <= 15%:\n3. attemptedIds.add(failedId) -> Re-enters lb.pickFiltered() for NEXT candidate!\n4. Transparently retries request up to maxAttempts (default: 2 or 4)\n5. If all retries exhausted: returns 502 Bad Gateway to client.", "#fff5f5", "#c92a2a", "#c92a2a");

// Column 2: All 12 Strategies & Worker Cluster Pool
const nStrats = compNode(c2X, S3_Y + 55, colW, 280, "🎯 ALL 12 LOAD BALANCING STRATEGIES (src/balancer/strategies/)", "• Round Robin / Weighted Round Robin (Nginx Smooth Weighted RR algorithm)\n• Adaptive WRR: weight * (1/(1+latency/100)) * (1 - errorRate)\n• Least Connections / Weighted Least Connections (activeConns / weight)\n• Least Response Time (min EWMA latency calculation)\n• Power of Two Choices (P2C: picks 2 random nodes, routes to lower load)\n• Consistent Hashing: 150 virtual nodes per node, 32-bit FNV-1a ring\n• IP Hash / Sticky Sessions (NINJA_ROUTE cookie) / Resource Based (cpu*0.7+mem*0.3)", "#ffffff", "#f08c00", "#d9480f");

const nWorkers = compNode(c2X, S3_Y + 375, colW, 280, "👷 WORKER CLUSTER POOL (src/core/cluster/worker.ts)", "• Worker 1, Worker 2, Worker 3 (normalized workers ?? os.cpus().length Fix #1)\n• Persistent Connection Pools: httpAgent & httpsAgent (maxSockets: 256, keepAlive: 10s)\n• Request Header Sanitization: strips hop-by-hop, Host rewrite, X-Forwarded-*\n• Upstream HTTP/HTTPS streaming execution via transport.request()\n• Response Decompression (zlib.gunzip) & Client Negotiation (zlib.gzip)", "#ffffff", "#2b8a3e", "#2b8a3e");

// Column 3: Resilience Suite & Upstream Backend Pool
const nResilience = compNode(c3X, S3_Y + 55, colW, 280, "🛡️ RESILIENCE & CIRCUIT BREAKERS (src/resilience/)", "• CircuitBreakerManager: Fix #8 clears stale breakers on hot reload!\n• Classic Circuit Breaker: CLOSED -> OPEN (failures >= 3) -> HALF_OPEN (15s)\n• Adaptive Circuit Breaker: Google SRE p(drop) = max(0, (req - 2*acc)/(req+1))\n• SRE RetryBudget: Global 15% budget cap prevents retry storm cascading failure\n• 4 Backoffs: Exponential, Full Jitter, Equal Jitter, Decorrelated Jitter\n• Bulkhead: Limits max concurrent execution slots per upstream", "#ffffff", "#d6336c", "#c2255c");

const nBackends = compNode(c3X, S3_Y + 375, colW, 280, "🏢 UPSTREAM BACKEND POOL", "• Backend A (http://backend-a:3001) [Weight: 1, MaxConns: 500]\n• Backend B (http://backend-b:3002) [Weight: 2, MaxConns: 500]\n• Backend C (https://backend-c:3003) [Weight: 1, TLS + Custom CA Buffer]\nProcesses actual microservice business logic & returns response stream\nUnder passive health surveillance and circuit breaker monitoring!", "#ffffff", "#1971c2", "#1864ab");

// Internal Arrows in Flow 3
arrow(nLB.right.x, nLB.center.y, nStrats.left.x, nStrats.center.y, '#e67700', 'pick(candidates)');
arrow(nStrats.right.x, nStrats.center.y, nResilience.left.x, nResilience.center.y, '#d6336c', 'isAllowed() & SRE ratio');
arrow(nLB.bottom.x, nLB.bottom.y, nDispatcher.top.x, nDispatcher.top.y, '#7048e8', 'Selected upstreamId');

arrow(nDispatcher.right.x, nDispatcher.center.y, nWorkers.left.x, nWorkers.center.y, '#7048e8', 'process.send(WorkerMessageType)');
arrow(nWorkers.right.x, nWorkers.center.y, nBackends.left.x, nBackends.center.y, '#2b8a3e', 'Pooled HTTP/HTTPS Stream');
arrow(nBackends.left.x, nBackends.center.y + 40, nWorkers.right.x, nWorkers.center.y + 40, '#2b8a3e', 'Response Chunks');
arrow(nWorkers.left.x, nWorkers.center.y + 40, nDispatcher.right.x, nDispatcher.center.y + 40, '#7048e8', 'WorkerReplyMessageType');

arrow(nDispatcher.bottom.x, nDispatcher.bottom.y, nRetryLoop.top.x, nRetryLoop.top.y, '#c92a2a', 'On 502/503/504 Failure');
arrow(nRetryLoop.left.x, nRetryLoop.center.y, nLB.left.x, nLB.center.y, '#c92a2a', 'Retry with alternate candidate');

// Cross-Flow Arrow from Flow 1 to Flow 3 (Vertical Corridor Connection)
arrow(nToLB.bottom.x, nToLB.bottom.y, nLB.top.x + 200, S3_Y, '#2b8a3e', 'Dispatches route-isolated candidates to LB');

console.log("Flow 3 constructed with load balancer & worker cluster wiring.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: WEBSOCKET UPGRADE, SERVICE REGISTRY & DUAL HEALTH PROBING (Flow 4)
// ═══════════════════════════════════════════════════════════════════════════════
const S4_Y = S3_Y + 1190;
rect(CANVAS_X, S4_Y, CANVAS_W, 950, '#c5f6fa', '#0c8599', 2);
txt(CANVAS_X + 24, S4_Y + 16, "🌐 LLD FLOW 4: WEBSOCKET DIRECT TUNNEL, DYNAMIC REGISTRY & DUAL-MODE HEALTH PROBES (src/core/proxy/ & src/discovery/)", "#0c8599", 18, CANVAS_W - 48, 1);

// Connecting Gateway Portal 4 down to Flow 4
arrow(p4.bottom.x, p4.bottom.y, CANVAS_X + 7000, S4_Y, '#0c8599', 'WS Tunnel & Dynamic Discovery');

// 3 Columns across 10600px width
const nWsFlow = compNode(c1X, S4_Y + 55, colW, 300, "🔌 WEBSOCKET DIRECT TUNNEL (src/core/proxy/websocket.handler.ts)", "• HTTP 'upgrade' event intercepted on Master server\n• Fix #3: Route isolation enforced (destroys socket if route upstreams = 0)\n• Protocol resolution: if wss/https -> tls.connect; else -> net.connect\n• Fix #14: Passes tlsConfig with CA buffer on fallback tunneling\n• Full Duplex Pipe: clientSocket.pipe(target) <-> target.pipe(clientSocket)\n• Zero protocol overhead; sub-microsecond binary frame streaming!", "#ffffff", "#0c8599", "#0c8599");

const nRegistry = compNode(c2X, S4_Y + 55, colW, 300, "📋 DYNAMIC SERVICE REGISTRY (src/discovery/registry/dynamic.registry.ts)", "• REST API: POST /__registry/register & PUT /__registry/heartbeat/:id\n• In-memory Map<id, ServiceInstance> with UP/DOWN state\n• Background GC: checkHeartbeats() evicts services after 30s timeout\n• Atomic Persistence: Writes temporary file -> atomic POSIX rename\n  proxy_registry_backup.json (survives proxy crashes and restarts!)\n• Event callbacks: onRegister & onDeregister notify LoadBalancer", "#ffffff", "#0c8599", "#087f5b");

const nHealthMgr = compNode(c3X, S4_Y + 55, colW, 300, "❤ DUAL-MODE HEALTH PROBING SUBSYSTEM (src/discovery/health/)", "ACTIVE PROBING (active.probe.ts):\n• checkUpstream(): HTTP/HTTPS GET to /health every 10s (5s timeout)\n• Custom CA support & TLS verification; sets status in HEALTHY_UPSTREAMS\n\nPASSIVE PROBING (passive.probe.ts & health.manager.ts):\n• Observes live user traffic responses in real-time\n• 5 errors (>= 500) in 30s sliding window -> trips upstream DOWN passively!\n• Single 200 OK -> immediately revives upstream UP passively!\n• Fix #6: Mutable getter keeps listener bound to active LB across reloads!", "#ffffff", "#087f5b", "#087f5b");

// Internal & Cross-Flow Arrows in Flow 4
arrow(nWsFlow.right.x, nWsFlow.center.y, nRegistry.left.x, nRegistry.center.y, '#0c8599', 'Route matched');
arrow(nRegistry.right.x, nRegistry.center.y, nHealthMgr.left.x, nHealthMgr.center.y, '#087f5b', 'Notifies registered upstreams');
arrow(nHealthMgr.left.x, nHealthMgr.center.y + 40, nLB.right.x, nLB.center.y + 40, '#087f5b', 'Mutates lb.setHealthy(id, state)');
arrow(nRegistry.top.x, nRegistry.top.y, nLB.bottom.x, nLB.bottom.y, '#087f5b', 'onRegister / onDeregister updates');
arrow(nWsFlow.top.x, nWsFlow.top.y, nBackends.bottom.x, nBackends.bottom.y, '#0c8599', 'Direct TCP/TLS Duplex Tunnel');

console.log("Flow 4 constructed with websocket & discovery cross-wiring.");

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: FULL OBSERVABILITY SUITE, ADMIN API & HOT RELOAD (LLD Flow 5)
// ═══════════════════════════════════════════════════════════════════════════════
const S5_Y = S4_Y + 1000;
rect(CANVAS_X, S5_Y, CANVAS_W, 950, '#f3f0ff', '#5f3dc4', 2);
txt(CANVAS_X + 24, S5_Y + 16, "📊 LLD FLOW 5: OBSERVABILITY SUITE, ADMIN CONTROL PLANE & ZERO-DOWNTIME HOT RELOAD (src/observability/ & src/config/)", "#5f3dc4", 18, CANVAS_W - 48, 1);

// Connecting Gateway Portal 5 down to Flow 5
arrow(p5.bottom.x, p5.bottom.y, CANVAS_X + 8800, S5_Y, '#5f3dc4', 'Observability & Hot Reload Rebuild');

// 3 Columns across 10600px width
const nObs = compNode(c1X, S5_Y + 55, colW, 300, "📊 OBSERVABILITY ENGINE (src/observability/)", "• MetricsRegistry: Counters (requests, errors) & Gauges (active connections, CPU, RAM)\n• HistogramRegistry: 10 latency buckets (5ms to 5000ms)\n• Cluster Snapshot Aggregation: Master polls workers over IPC & merges snapshots\n• Distributed Tracer: Generates and propagates X-Trace-Id across spans\n• TenantLogStreamer: 10k tenant queue, 1s batch flush over HTTP POST webhooks\n• ReadinessProbe (Fix #7): Deduplicates by name and supports clear() on reload", "#ffffff", "#5f3dc4", "#5f3dc4");

const nAdmin = compNode(c2X, S5_Y + 55, colW, 300, "🕹️ ADMIN API CONTROL PLANE (src/core/admin/admin.handler.ts)", "• Fix #12: Supports both root paths and configured admin.pathPrefix (/__admin/*)\n• GET /__lb-stats: Real-time upstream active connections, EWMA latency, CB states\n• GET /metrics & /__metrics: Cluster-wide Prometheus text exposition (version 0.0.4)\n• GET /__registry: Dynamic service discovery instance statuses\n• GET /__ready & /__health: Subsystem readiness checks (Redis, Upstreams)\n• GET /__cache-stats: L1 memory and L2 Redis hit/miss counters", "#ffffff", "#6741d9", "#5f3dc4");

const nHotReload = compNode(c3X, S5_Y + 55, colW, 300, "🔄 CONFIG ENGINE & HOT RELOAD (src/config/config.loader.ts)", "• parseYAMLConfig: Parses config.yaml & merges config.d/*.yaml in parallel\n• Inotify Watchers: fs.watch on config.yaml & config.d/ with 100ms debounce\n• SIGHUP Signal Handler: Triggers zero-downtime hot reload\n• reloadServerConfig() Safety Rebuild:\n  1. Fix #8: Calls circuitBreakerManager.clear() to discard stale breakers\n  2. Fix #7: Calls readinessProbe.clear() to prevent duplicate checks\n  3. Rebuilds LoadBalancer, Cache, and RateLimiters with full parity (Fix #10, #11)\n  4. Forks new workers and sends GRACEFUL_SHUTDOWN to old workers!", "#ffffff", "#2b8a3e", "#2b8a3e");

// Internal & Cross-Flow Arrows in Flow 5
arrow(nObs.right.x, nObs.center.y, nAdmin.left.x, nAdmin.center.y, '#5f3dc4', 'Emits aggregated metrics');
arrow(nAdmin.right.x, nAdmin.center.y, nHotReload.left.x, nHotReload.center.y, '#2b8a3e', 'Hot-reload reconfigures subsystems');

// Local upward/downward connections within LLD
arrow(nAdmin.top.x, nAdmin.top.y, nLB.bottom.x, nLB.bottom.y, '#6741d9', 'Scrapes /__lb-stats');
arrow(nHotReload.left.x, nHotReload.center.y - 40, nResilience.bottom.x, nResilience.bottom.y, '#d6336c', 'Hot reload clears circuitBreakerManager (Fix #8)');

console.log("Flow 5 constructed with observability & hot reload cross-wiring.");

// ═══════════════════════════════════════════════════════════════════════════════
// EXPAND MASTER OUTER CONTAINER (Unifies everything inside one cohesive canvas)
// ═══════════════════════════════════════════════════════════════════════════════
if (outerContainer) {
  const bottomOfFlow5 = S5_Y + 950;
  outerContainer.height = Math.round(bottomOfFlow5 - outerContainer.y + 100);
  console.log(`Expanded master outer container height to ${outerContainer.height}px.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMIT ALL ELEMENTS & WRITE OUTPUT FILE
// ═══════════════════════════════════════════════════════════════════════════════
raw.elements = [...base156, ...newElements];
writeFileSync(diagramFile, JSON.stringify(raw, null, 2));

const arrowCount = raw.elements.filter(e => e.type === 'arrow').length;
const rectCount = raw.elements.filter(e => e.type === 'rectangle').length;
const textCount = raw.elements.filter(e => e.type === 'text').length;

console.log(`\n========================================================================`);
console.log(`🎉 100% UNIFIED & FULLY INTERCONNECTED EXCALIDRAW ARCHITECTURE GENERATED!`);
console.log(`========================================================================`);
console.log(`• Base HLD Elements Preserved & Path-Updated: ${base156.length}`);
console.log(`• New LLD Engine Nodes, Rectangles & Arrows: ${newElements.length}`);
console.log(`• Total Architecture Diagram Elements: ${raw.elements.length}`);
console.log(`  - Rectangles & Component Containers: ${rectCount}`);
console.log(`  - Directional Arrows (HLD-LLD Bridges & Cross-Flows): ${arrowCount}`);
console.log(`  - Text Blocks (Full Code, Contracts, Fixes): ${textCount}`);
console.log(`• Output File: ${diagramFile}`);
console.log(`• File Size: ${(Buffer.byteLength(JSON.stringify(raw)) / 1024).toFixed(1)} KB`);
console.log(`========================================================================\n`);
