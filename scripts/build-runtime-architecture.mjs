#!/usr/bin/env node
/**
 * Generates an accurate, connected Excalidraw map of the current runtime.
 * It deliberately separates executable request paths from source modules that
 * exist but are not imported by master.ts or worker.ts.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const outputFile = "docs/ninja-reverse-proxy-runtime-architecture.excalidraw";
const now = Date.now();
const elements = [];
const nodes = new Map();

const colors = {
  ink: "#1f2933",
  blue: "#1864ab",
  blueFill: "#e7f5ff",
  green: "#2b8a3e",
  greenFill: "#ebfbee",
  orange: "#d9480f",
  orangeFill: "#fff4e6",
  violet: "#5f3dc4",
  violetFill: "#f3f0ff",
  teal: "#087f5b",
  tealFill: "#e6fcf5",
  red: "#c92a2a",
  redFill: "#fff5f5",
  gray: "#495057",
  grayFill: "#f8f9fa",
};

function id() {
  return randomBytes(6).toString("base64url");
}

function element(type, data) {
  return {
    id: id(),
    type,
    angle: 0,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `b${id()}`,
    seed: Math.floor(Math.random() * 1e9),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1e9),
    isDeleted: false,
    boundElements: [],
    updated: now,
    link: null,
    locked: false,
    ...data,
  };
}

function rectangle(x, y, width, height, fill, stroke, strokeStyle = "solid", widthPx = 2) {
  const rect = element("rectangle", {
    x,
    y,
    width,
    height,
    strokeColor: stroke,
    backgroundColor: fill,
    strokeWidth: widthPx,
    strokeStyle,
    roundness: { type: 3 },
  });
  elements.push(rect);
  return rect;
}

function text(x, y, value, color = colors.ink, fontSize = 14, width = 200, family = 3, align = "left") {
  const lineCount = value.split("\n").length;
  const item = element("text", {
    x,
    y,
    width,
    height: Math.ceil(lineCount * fontSize * 1.28 + 4),
    strokeColor: color,
    backgroundColor: "transparent",
    roundness: null,
    text: value,
    fontSize,
    fontFamily: family,
    textAlign: align,
    verticalAlign: "top",
    containerId: null,
    originalText: value,
    autoResize: true,
    lineHeight: 1.25,
  });
  elements.push(item);
  return item;
}

function section(x, y, width, height, title, tone) {
  rectangle(x, y, width, height, tone.fill, tone.stroke, "solid", 3);
  text(x + 20, y + 16, title, tone.stroke, 20, width - 40, 1);
}

function node(key, x, y, width, height, title, body, tone, options = {}) {
  const rect = rectangle(
    x,
    y,
    width,
    height,
    tone.fill,
    tone.stroke,
    options.dashed ? "dashed" : "solid",
    options.widthPx ?? 2,
  );
  text(x + 14, y + 12, title, tone.stroke, options.titleSize ?? 15, width - 28, 1);
  if (body) text(x + 14, y + 42, body, colors.ink, options.bodySize ?? 11, width - 28);
  const item = {
    key,
    id: rect.id,
    x,
    y,
    width,
    height,
    top: { x: x + width / 2, y },
    bottom: { x: x + width / 2, y: y + height },
    left: { x, y: y + height / 2 },
    right: { x: x + width, y: y + height / 2 },
    center: { x: x + width / 2, y: y + height / 2 },
  };
  nodes.set(key, item);
  return item;
}

function anchor(item, side) {
  return item[side] ?? item.center;
}

function edge(fromKey, fromSide, toKey, toSide, label, color, options = {}) {
  const from = nodes.get(fromKey);
  const to = nodes.get(toKey);
  if (!from || !to) throw new Error(`Unknown node in edge: ${fromKey} -> ${toKey}`);
  const start = anchor(from, fromSide);
  const end = anchor(to, toSide);
  const via = options.via ?? [];
  const points = [start, ...via, end];
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const relative = points.map((p) => [Math.round(p.x - minX), Math.round(p.y - minY)]);
  const arrow = element("arrow", {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(Math.max(...relative.map((p) => p[0]))),
    height: Math.round(Math.max(...relative.map((p) => p[1]))),
    strokeColor: color,
    backgroundColor: "transparent",
    strokeStyle: options.dashed ? "dashed" : "solid",
    strokeWidth: options.widthPx ?? 2,
    roundness: { type: 2 },
    points: relative,
    lastCommittedPoint: null,
    startBinding: { elementId: from.id, focus: 0, gap: 1 },
    endBinding: { elementId: to.id, focus: 0, gap: 1 },
    startArrowhead: null,
    endArrowhead: "arrow",
  });
  elements.push(arrow);
  const sourceRect = elements.find((e) => e.id === from.id);
  const targetRect = elements.find((e) => e.id === to.id);
  sourceRect.boundElements.push({ id: arrow.id, type: "arrow" });
  targetRect.boundElements.push({ id: arrow.id, type: "arrow" });

  if (label) {
    const labelPoint = via[0] ?? {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
    const labelWidth = Math.max(90, label.length * 6.3 + 16);
    rectangle(labelPoint.x - labelWidth / 2, labelPoint.y - 11, labelWidth, 19, "#ffffff", "#ffffff", "solid", 1);
    text(labelPoint.x - labelWidth / 2 + 5, labelPoint.y - 10, label, color, 10, labelWidth - 10, 3, "center");
  }
}

function note(x, y, width, value, tone) {
  rectangle(x, y, width, 56, tone.fill, tone.stroke, "solid", 1);
  text(x + 10, y + 9, value, tone.stroke, 11, width - 20);
}

// Title and legend
text(80, 42, "NINJA REVERSE PROXY - CONNECTED RUNTIME ARCHITECTURE", colors.ink, 27, 2200, 1);
text(80, 82, "Source-grounded map of src/ as implemented on 2026-09-20", colors.gray, 13, 900);
rectangle(3450, 42, 20, 12, colors.greenFill, colors.green, "solid", 2);
text(3480, 39, "solid = active runtime data/control flow", colors.gray, 11, 360);
rectangle(3850, 42, 20, 12, colors.violetFill, colors.violet, "dashed", 2);
text(3880, 39, "dashed = lifecycle, background, or source-only relation", colors.gray, 11, 460);
rectangle(3450, 70, 20, 12, colors.redFill, colors.red, "solid", 2);
text(3480, 67, "red = current code caveat, not an intended future behavior", colors.gray, 11, 520);

// Control plane and configuration lifecycle.
section(60, 125, 4480, 535, "1. CONFIGURATION, PROCESS LIFECYCLE, AND SERVICE STATE", { fill: colors.grayFill, stroke: colors.gray });
node("config-files", 90, 190, 400, 155, "Config sources", "config.yaml\nconfig.d/*.yaml\nPORT, HOST, WORKERS, REDIS_* env", { fill: "#ffffff", stroke: colors.blue });
node("config-loader", 560, 180, 490, 180, "Config loader", "parseYAMLConfig()\nmerge config.d additions\nmap legacy port/listen, TLS, routes/paths\napply environment overrides", { fill: "#ffffff", stroke: colors.blue });
node("schema", 1120, 190, 420, 155, "Zod rootConfigSchema", "server, tls, upstreams, routes\nloadBalancing, resilience, rateLimit\ncache, discovery, admin, observability", { fill: "#ffffff", stroke: colors.violet });
node("bootstrap", 1610, 180, 460, 180, "Bootstrap: src/index.ts", "CLI config selection\nuncaught error exit contract\nSIGHUP and fs.watch reload triggers\ncluster primary vs worker branch", { fill: "#ffffff", stroke: colors.violet });
node("master-state", 2150, 170, 570, 205, "Master state: master.ts", "ACTIVE_CONFIG, WORKER_POOL\nHEALTHY_UPSTREAMS, pending requests\nLoadBalancer, Cache, RateLimiters\nBulkheads, RetryBudget, MetricsRegistry", { fill: "#ffffff", stroke: colors.green });
node("worker-life", 2800, 180, 560, 180, "Cluster worker lifecycle", "cluster.fork({ APP_CONFIG })\nworker exit -> replacement worker\nreload forks new workers then retires old\nUPDATE_SERVICES broadcasts healthy IDs", { fill: "#ffffff", stroke: colors.green });
node("registry", 3440, 180, 510, 180, "Dynamic service registry", "Map<id, ServiceInstance>\nregister / heartbeat / deregister\n30s heartbeat timeout\nonRegister/onDeregister changes LB", { fill: "#ffffff", stroke: colors.teal });
node("health", 4025, 180, 480, 180, "Health manager", "initial health check then 10s active probes\npassive: 5 x 5xx in 30s marks DOWN\nupdates HEALTHY_UPSTREAMS + lb.setHealthy()", { fill: "#ffffff", stroke: colors.teal });
edge("config-files", "right", "config-loader", "left", "read + merge", colors.blue);
edge("config-loader", "right", "schema", "left", "validate", colors.violet);
edge("schema", "right", "bootstrap", "left", "validated config", colors.violet);
edge("bootstrap", "right", "master-state", "left", "createServer()", colors.green);
edge("master-state", "right", "worker-life", "left", "fork and supervise", colors.green);
edge("master-state", "right", "registry", "left", "static upstream registration", colors.teal, { via: [{ x: 3050, y: 485 }] });
edge("registry", "right", "health", "left", "service list", colors.teal);
edge("health", "bottom", "master-state", "bottom", "healthy-state mutation", colors.teal, { dashed: true, via: [{ x: 4265, y: 500 }, { x: 2440, y: 500 }] });
edge("registry", "bottom", "worker-life", "bottom", "registry callback -> UPDATE_SERVICES", colors.teal, { dashed: true, via: [{ x: 3695, y: 470 }, { x: 3080, y: 470 }] });
edge("bootstrap", "bottom", "master-state", "bottom", "SIGHUP / fs.watch -> reloadServerConfig()", colors.violet, { dashed: true, via: [{ x: 1840, y: 500 }, { x: 2425, y: 500 }] });

// Main HTTP request path.
section(60, 705, 4480, 860, "2. HTTP REQUEST PATH - MASTER PIPELINE, SELECTION, IPC, AND RESPONSE", { fill: colors.blueFill, stroke: colors.blue });
node("client", 90, 795, 400, 165, "Client", "Browser, mobile, API client\nHTTP, HTTPS, or Upgrade request\nheaders: Host, Cookie, Authorization", { fill: "#ffffff", stroke: colors.blue });
node("ingress", 565, 785, 475, 185, "HTTP / HTTPS ingress", "HTTP server on configured port\nHTTPS server with TLS when enabled\nHTTP redirects to HTTPS except selected admin paths\nupgrade event enters WS flow", { fill: "#ffffff", stroke: colors.green });
node("gateway", 1120, 775, 530, 205, "Master request gateway", "handleAdminRequest() first\notherwise createContext(req, res)\nconstruct MiddlewarePipeline\nproxyRequestHandler()", { fill: "#ffffff", stroke: colors.violet });
node("admin", 1730, 800, 440, 155, "Admin and monitoring endpoints", "/__lb-stats, /metrics, /__metrics\n/__registry, /__ready, /__health\n/__cache-stats and registry mutation APIs", { fill: "#ffffff", stroke: colors.violet });
node("trace-cors-body", 95, 1180, 520, 250, "Pipeline stage 1", "corsMiddleware()\ntracingMiddleware(): X-Trace-Id + in-memory span\nbodyLimitMiddleware(10 MB): Content-Length check\nOPTIONS exits at CORS stage", { fill: "#ffffff", stroke: colors.blue });
node("rate-gate", 690, 1180, 455, 250, "Pipeline stage 2: rate gates", "global RateLimiter then route limiter\nkey = client IP\nblocked request returns 429 + Retry-After\nrecords limiter metrics", { fill: "#ffffff", stroke: colors.orange });
node("cache-gate", 1220, 1180, 465, 250, "Pipeline stage 3: cache", "GET/HEAD cache lookup\ncache HIT returns immediately\nwrite methods invalidate path\nMISS continues to dispatch", { fill: "#ffffff", stroke: colors.blue });
node("selection", 1760, 1120, 610, 325, "Route selection + resilience", "path prefix match in server.paths\ncanary or sticky-cookie preference\nroute healthy set intersects configured route upstreams\nLoadBalancer filters: health, circuit, capacity, attempted IDs\nBulkhead admission before worker dispatch", { fill: "#ffffff", stroke: colors.orange });
node("ipc", 2450, 1180, 450, 250, "Master IPC dispatcher", "assign worker round-robin\ncreate requestId + pending timer\ntrack active connection and bulkhead slot\nprocess.send({ upstreamUrl, payload })", { fill: "#ffffff", stroke: colors.violet });
node("worker", 2980, 1135, 575, 340, "Worker HTTP proxy", "validates IPC message\nfinds route again, uses master-selected URL\npooled HTTP/HTTPS agents (256 sockets)\nheader normalization + X-Forwarded-*\nupstream request, gzip/gunzip, reply IPC\nworker-local metrics and access logs", { fill: "#ffffff", stroke: colors.green });
node("upstreams", 3640, 1190, 820, 230, "Upstream applications", "Configured services and dynamically registered services\nHTTP/HTTPS upstream transport\napplication response or timeout / connection error\nper-upstream weight, maxConnections, TLS CA config", { fill: "#ffffff", stroke: colors.teal });
edge("client", "right", "ingress", "left", "request", colors.blue);
edge("ingress", "right", "gateway", "left", "request event", colors.green);
edge("gateway", "right", "admin", "left", "admin path", colors.violet);
edge("gateway", "bottom", "trace-cors-body", "top", "non-admin request", colors.blue, { via: [{ x: 1385, y: 1080 }, { x: 355, y: 1080 }] });
edge("trace-cors-body", "right", "rate-gate", "left", "next()", colors.blue);
edge("rate-gate", "right", "cache-gate", "left", "allowed", colors.orange);
edge("cache-gate", "right", "selection", "left", "cache miss", colors.blue);
edge("selection", "right", "ipc", "left", "selected upstream", colors.orange);
edge("ipc", "right", "worker", "left", "JSON IPC payload", colors.violet);
edge("worker", "right", "upstreams", "left", "pooled HTTP/HTTPS", colors.green);
edge("upstreams", "bottom", "worker", "bottom", "response stream", colors.green, { via: [{ x: 4050, y: 1510 }, { x: 3265, y: 1510 }] });
edge("worker", "bottom", "ipc", "bottom", "reply IPC", colors.violet, { via: [{ x: 3265, y: 1515 }, { x: 2675, y: 1515 }] });
edge("ipc", "bottom", "selection", "bottom", "failure -> retry/backoff", colors.red, { via: [{ x: 2675, y: 1515 }, { x: 2065, y: 1515 }] });
edge("selection", "top", "master-state", "bottom", "reads config, LB state, retry budget", colors.orange, { dashed: true, via: [{ x: 2065, y: 1030 }, { x: 2440, y: 1030 }] });
edge("selection", "top", "registry", "bottom", "resolves selected service URL", colors.teal, { dashed: true, via: [{ x: 2065, y: 1050 }, { x: 3695, y: 1050 }] });

// State systems supporting the request path.
section(60, 1610, 4480, 820, "3. SHARED STATE, RESILIENCE, HEALTH, CACHE INVALIDATION, AND OBSERVABILITY", { fill: colors.grayFill, stroke: colors.gray });
node("ratelimiter", 100, 1685, 560, 210, "RateLimiter", "five algorithms: fixed window, sliding log\nsliding counter, token bucket, leaking bucket\nSoftLimitPolicy can expand burst limit\nmaster creates global and route instances", { fill: "#ffffff", stroke: colors.orange });
node("rl-state", 100, 1985, 560, 265, "Rate-limit state", "memory mode: algorithm-owned Maps\nredis mode: Lua EVAL is atomic\nINCR / ZSET / HASH operations per algorithm\nhybrid algorithm requires both local state and Redis client", { fill: "#ffffff", stroke: colors.orange });
node("cache", 755, 1685, 565, 210, "Cache facade", "master-only Cache instance\nGET/HEAD lookups and response cache writes\nL1 HybridCache if l1Enabled\nL2 RedisCache with TTL", { fill: "#ffffff", stroke: colors.blue });
node("cache-state", 755, 1985, 565, 265, "Cache data and invalidation", "InMemoryLRU: TTL + LRU eviction\nRedisCache: GET / SET EX / DEL / KEYS invalidation\nDebezium subscriber -> DebeziumInvalidator\nwrite request invalidates matching path", { fill: "#ffffff", stroke: colors.blue });
node("resilience", 1415, 1685, 600, 255, "Resilience execution", "CircuitBreakerManager per upstream\nclassic CLOSED / OPEN / HALF_OPEN or adaptive drop\nBulkhead enter()/leave() per upstream\nRetryBudget limits retry ratio\nexponential, full/equal/decorrelated jitter", { fill: "#ffffff", stroke: colors.red });
node("probe-flow", 2100, 1685, 560, 255, "Health feedback", "active probe sends GET healthPath to upstream\npassiveProbe sees normal worker response outcomes\nhealth manager mutates HEALTHY_UPSTREAMS\nand LoadBalancer.setHealthy(id, state)", { fill: "#ffffff", stroke: colors.teal });
node("metrics", 2750, 1685, 600, 255, "Metrics and logs", "master MetricsRegistry + worker-local registries\nadmin /metrics polls workers by IPC, merges snapshots\nPrometheus counters, gauges, latency histogram\naccess log plus optional tenant webhook batches", { fill: "#ffffff", stroke: colors.violet });
node("exports", 3440, 1685, 980, 255, "Operational consumers", "Prometheus scrapes /metrics\nGrafana queries Prometheus\noperators use registry / health / LB / cache admin endpoints\ntenant destinations receive queued webhook log batches", { fill: "#ffffff", stroke: colors.violet });
node("source-only", 2770, 2045, 1650, 285, "Source modules present but not on master.ts / worker.ts live path", "Router and RouteMatcher; auth, cache, circuit, logging, generic rate-limit middleware\nproxyRequest(), connection.pool.ts, UpstreamClient, RetryHandler\nCacheControlParser, KeyBuilder, StaleWhileRevalidate, StaleIfError, TagInvalidator, PatternInvalidator\nMemoryStore, RedisStore, HybridStore, circuit state helper classes\nThese are useful library code, but the active master/worker flow uses the concrete logic described above.", { fill: "#ffffff", stroke: colors.gray }, { dashed: true, bodySize: 11 });
edge("rate-gate", "bottom", "ratelimiter", "top", "isAllowed(client IP)", colors.orange);
edge("ratelimiter", "bottom", "rl-state", "top", "algorithm state", colors.orange);
edge("cache-gate", "bottom", "cache", "top", "get / invalidate", colors.blue);
edge("cache", "bottom", "cache-state", "top", "L1 then Redis", colors.blue);
edge("selection", "bottom", "resilience", "top", "circuit, retry, bulkhead", colors.red, { dashed: true, via: [{ x: 2065, y: 1600 }, { x: 1715, y: 1600 }] });
edge("upstreams", "bottom", "probe-flow", "top", "active probe and passive outcomes", colors.teal, { dashed: true, via: [{ x: 4050, y: 1600 }, { x: 2380, y: 1600 }] });
edge("probe-flow", "top", "health", "bottom", "changes healthy set", colors.teal, { dashed: true, via: [{ x: 2380, y: 1510 }, { x: 4265, y: 1510 }] });
edge("gateway", "bottom", "metrics", "top", "rate-limit/cache/admin metrics", colors.violet, { dashed: true, via: [{ x: 1385, y: 1645 }, { x: 3050, y: 1645 }] });
edge("worker", "bottom", "metrics", "top", "DUMP_METRICS_RESPONSE + logs", colors.violet, { dashed: true, via: [{ x: 3265, y: 1600 }, { x: 3050, y: 1600 }] });
edge("metrics", "right", "exports", "left", "Prometheus exposition / webhook", colors.violet);
edge("source-only", "top", "ratelimiter", "bottom", "available library surface", colors.gray, { dashed: true, via: [{ x: 3595, y: 1960 }, { x: 380, y: 1960 }] });
edge("source-only", "top", "cache", "bottom", "available library surface", colors.gray, { dashed: true, via: [{ x: 3595, y: 1975 }, { x: 1038, y: 1975 }] });
edge("source-only", "top", "resilience", "bottom", "available library surface", colors.gray, { dashed: true, via: [{ x: 3595, y: 1990 }, { x: 1715, y: 1990 }] });

// Websocket path and implementation notes.
section(60, 2475, 4480, 585, "4. WEBSOCKET PATH AND CURRENT IMPLEMENTATION NOTES", { fill: colors.tealFill, stroke: colors.teal });
node("ws-client", 100, 2570, 400, 180, "WebSocket client", "HTTP Upgrade or WSS Upgrade\npath and Cookie are available to selection\nno HTTP cache or rate-limit pipeline", { fill: "#ffffff", stroke: colors.teal });
node("ws-master", 580, 2570, 530, 180, "Master upgrade handler", "finds matching server.paths rule\ncanary / sticky / load-balancer selection\nincrements connection metrics\nchooses worker socket handoff or direct TLS tunnel", { fill: "#ffffff", stroke: colors.teal });
node("ws-worker", 1190, 2570, 575, 180, "Worker socket handoff", "WEBSOCKET_UPGRADE + socket handle\nworker tunnelWebSocket()\nnet.connect or tls.connect\nclose message releases LB connection", { fill: "#ffffff", stroke: colors.green });
node("ws-tunnel", 1845, 2570, 550, 180, "WebSocket tunnel", "replays upgrade request\nclientSocket.pipe(targetSocket)\ntargetSocket.pipe(clientSocket)\nTLS supports upstream CA settings", { fill: "#ffffff", stroke: colors.green });
node("ws-upstream", 2475, 2570, 520, 180, "WebSocket upstream", "HTTP or HTTPS / WSS endpoint\nfull-duplex application frames\nclose triggers connection release", { fill: "#ffffff", stroke: colors.teal });
node("caveats", 3080, 2530, 1320, 325, "Current implementation truth markers", "1. workers: 0 reaches createServer as 0, so it can fork no normal HTTP workers.\n2. bodyLimitMiddleware checks only Content-Length; chunked oversized bodies can still reach dispatch.\n3. matched routes fall back to all HEALTHY_UPSTREAMS when their own healthy set is empty.\n4. Redis client creation / injection currently checks storage === 'redis', not 'hybrid'.\n5. admin.pathPrefix and observability.metrics.path are schema fields, but handler paths are hard-coded.\n6. health state broadcasts occur on registry changes; active/passive probe transitions do not broadcast worker health updates.", { fill: colors.redFill, stroke: colors.red }, { bodySize: 11 });
edge("ws-client", "right", "ws-master", "left", "upgrade", colors.teal);
edge("ws-master", "right", "ws-worker", "left", "socket handoff", colors.teal);
edge("ws-worker", "right", "ws-tunnel", "left", "tunnelWebSocket()", colors.green);
edge("ws-tunnel", "right", "ws-upstream", "left", "TCP/TLS duplex", colors.green);
edge("ws-master", "top", "selection", "bottom", "same route/LB decision", colors.orange, { dashed: true, via: [{ x: 845, y: 2445 }, { x: 2065, y: 2445 }] });
edge("ws-worker", "top", "worker-life", "bottom", "worker process", colors.green, { dashed: true, via: [{ x: 1477, y: 2425 }, { x: 3080, y: 2425 }] });

note(80, 3115, 2100, "This diagram intentionally maps the code as it is today. It does not portray planned hardening work as already implemented.", { fill: colors.redFill, stroke: colors.red });
note(2230, 3115, 2200, "Solid arrows show an active request/state flow; dashed arrows show lifecycle, background, or source-inventory relationships.", { fill: colors.grayFill, stroke: colors.gray });

const scene = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: "#ffffff",
  },
  files: {},
};

writeFileSync(outputFile, JSON.stringify(scene, null, 2));
console.log(`Wrote ${elements.length} elements to ${outputFile}`);
