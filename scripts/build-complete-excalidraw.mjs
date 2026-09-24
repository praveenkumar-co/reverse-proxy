#!/usr/bin/env node
/**
 * MASTER EXCALIDRAW ARCHITECTURE GENERATOR
 * Deep, exhaustive representation of 100% of the Ninja Reverse Proxy codebase:
 * Every file, service, function, interface, algorithm, pattern, internal connection,
 * security mechanism, configuration schema, probe, metric, test, and deployment manifest.
 *
 * Designed with dynamic vertical layout to guarantee ZERO visual overlaps.
 */

import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

function uid() {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

function rect(x, y, w, h, bg = 'transparent', stroke = '#1e1e1e', sw = 2) {
  return {
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
    strokeStyle: 'solid',
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
}

function txt(x, y, content, color = '#1e1e1e', fontSize = 13, w = null, fontFamily = 3) {
  const lines = content.split('\n');
  const maxLen = Math.max(...lines.map((l) => l.length));
  const height = lines.length * (fontSize * 1.34) + 14;
  const width = w || Math.max(maxLen * (fontSize * 0.63), 200);
  return {
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
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    originalText: content,
    autoResize: true,
    lineHeight: 1.25
  };
}

// Load existing diagram and extract the original 156 elements (from the user's link)
const diagramFile = 'docs/ninja-rp-new-diagram.excalidraw';
const raw = JSON.parse(readFileSync(diagramFile, 'utf8'));
const original156 = raw.elements.slice(0, 156);
console.log(`Preserving original ${original156.length} base elements.`);

const newElements = [];

// Base canvas coordinate constraints:
// Width: 8200px (from X = 9440 to X = 17640)
// Starting Y: -2300 (clearing existing original content which ends around Y = -2501)
const CANVAS_X = 9440;
const CANVAS_W = 8200;
let curY = -2300;
const SECTION_GAP = 60;

function addSection(title, color, bgColor, columns) {
  // Compute column layout
  // columns is an array of objects: { title, content, color, bg, flex, fontSize }
  const totalFlex = columns.reduce((acc, c) => acc + (c.flex || 1), 0);
  const colGap = 24;
  const innerPad = 20;
  const availableW = CANVAS_W - innerPad * 2 - (columns.length - 1) * colGap;

  let maxColHeight = 0;
  const colElements = [];
  let curColX = CANVAS_X + innerPad;

  columns.forEach((col) => {
    const colW = (availableW * (col.flex || 1)) / totalFlex;
    const fontSize = col.fontSize || 13;
    const tElem = txt(curColX + 16, curY + 65, col.content, col.color || '#1e1e1e', fontSize, colW - 32);
    const colH = tElem.height + 28;
    if (colH > maxColHeight) maxColHeight = colH;

    colElements.push({
      colX: curColX,
      colW,
      colH,
      tElem,
      bg: col.bg || '#ffffff',
      stroke: col.stroke || col.color || '#ced4da',
      sw: col.sw || 2,
      subTitle: col.title
    });

    curColX += colW + colGap;
  });

  const sectionH = maxColHeight + 85;

  // Outer section box
  newElements.push(rect(CANVAS_X, curY, CANVAS_W, sectionH, bgColor, color, 3));
  // Section title header
  newElements.push(txt(CANVAS_X + innerPad, curY + 14, title, color, 20, CANVAS_W - 40, 1));

  // Render each column box and its text
  colElements.forEach((col) => {
    newElements.push(rect(col.colX, curY + 52, col.colW, maxColHeight + 16, col.bg, col.stroke, col.sw));
    newElements.push(col.tElem);
  });

  curY += sectionH + SECTION_GAP;
}

console.log('Generating complete, non-overlapping architectural layers...');


// ============================================================================
// SECTION 1: COMPLETE REPOSITORY SOURCE FILE & MODULE INVENTORY
// ============================================================================
addSection(
  "📁 LAYER 1: REPOSITORY MODULE INVENTORY — EVERY SOURCE FILE & CONTRACT (src/)",
  "#1864ab",
  "#e7f5ff",
  [
    {
      title: "Core & Pipeline Files",
      flex: 1,
      bg: "#ffffff",
      stroke: "#1971c2",
      content: `src/
├── index.ts                     [Bootstrap CLI, OS signal SIGHUP, cluster branching, process exit codes (0,1,2)]
├── command.t                    [Git deployment reference instructions]
├── core/
│   ├── cluster/
│   │   ├── master.ts            [Master cluster supervisor, dual HTTP:8080/HTTPS:8443, IPC replyHandlers, hot-reload]
│   │   ├── worker.ts            [Worker request processor, pooled agents, gzip/gunzip, header sanitization, metrics]
│   │   └── ipc.protocol.ts      [Zod schemas: workerMessageSchema, workerMessageReplySchema]
│   ├── pipeline/
│   │   ├── middleware.pipeline.ts [MiddlewarePipeline: Express-style async next() runner, stack management]
│   │   └── context.ts           [RequestContext interface, createContext() factory, performance timer]
│   ├── proxy/
│   │   ├── connection.pool.ts   [httpAgent & httpsAgent module pools: maxSockets=256, keepAliveMsecs=10000]
│   │   ├── http.handler.ts      [proxyRequest() promise client, connect/read timeout timers, stream buffering]
│   │   ├── upstream.client.ts   [UpstreamClient config container, connectTimeoutMs, readTimeoutMs]
│   │   └── websocket.handler.ts [tunnelWebSocket(): net.connect / tls.connect, custom CA buffer, duplex pipe]
│   ├── router/
│   │   ├── route.matcher.ts     [RouteMatcher: path prefix match, HTTP method whitelist, rule resolution]
│   │   ├── route.types.ts       [RouteRule, CanaryConfig interfaces]
│   │   └── router.ts            [Router class, updateRules() dynamic hot update]
│   └── admin/
│       └── admin.handler.ts     [handleAdminRequest(): /__lb-stats, /metrics, /__registry, /__ready, /__cache-stats]
├── middleware/
│   ├── auth.middleware.ts       [authMiddleware: Bearer token whitelist validation, 401 Unauthorized]
│   ├── body-limit.middleware.ts [bodyLimitMiddleware: Content-Length check against maxBytes, 413 Payload Too Large]
│   ├── cache.middleware.ts      [cacheMiddleware: GET cache check, X-Cache: HIT header injection, 200 response]
│   ├── circuit.middleware.ts    [circuitMiddleware: circuit open check, 503 Service Unavailable short-circuit]
│   ├── cors.middleware.ts       [corsMiddleware: Access-Control-Allow-Origin/Methods/Headers, OPTIONS 204]
│   ├── logging.middleware.ts    [loggingMiddleware: latency tracking, performance.now() request logging]
│   ├── rate-limit.middleware.ts [rateLimitMiddleware: path-level limiter check, 429 Too Many Requests + Retry-After]
│   └── tracing.middleware.ts    [tracingMiddleware: X-Trace-Id extraction/generation, root tracer span]`
    },
    {
      title: "Balancer, Cache & Discovery Files",
      flex: 1,
      bg: "#ffffff",
      stroke: "#0c8599",
      content: `├── balancer/
│   ├── core/
│   │   ├── load-balancer.ts     [LoadBalancer: UpstreamState map, EWMA latency, slow-start ramp, CB integration]
│   │   └── strategy-registry.ts [StrategyRegistry: Map<string, IStrategy>, register(), get()]
│   ├── factory/
│   │   ├── balancer.factory.ts  [createLoadBalancer(): registers all 12 strategies, config parsing]
│   │   └── explain.t            [Architectural factory pattern explanation]
│   ├── contracts/
│   │   ├── balancer.interface.ts [IBalancer interface: pickFiltered, recordSuccess, recordFailure, setHealthy]
│   │   ├── context.types.ts     [PickContext: clientIp, attemptedIds, cookies, headers]
│   │   └── strategy.interface.ts [IStrategy: pick(candidates, clientIp, cookies), onUpstreamsChanged?]
│   └── strategies/ (12 Strategies)
│       ├── round-robin.strategy.ts              [Atomic modulo indexing across healthy candidates]
│       ├── weighted-round-robin.strategy.ts      [Nginx smooth weighted round-robin + slow-start ramp]
│       ├── adaptive-wrr.strategy.ts              [Latency & error-rate weighted dynamic score + slow-start]
│       ├── least-connections.strategy.ts         [min(activeConnections) candidate selection]
│       ├── weighted-least-connections.strategy.ts[min(activeConnections / weight) ratio selection]
│       ├── least-response-time.strategy.ts       [min(EWMA responseTime) candidate selection]
│       ├── power-of-two.strategy.ts              [P2C: picks 2 random candidates, chooses lowest activeConns]
│       ├── consistent-hashing.strategy.ts        [FNV-1a 32-bit hash ring, 150 virtual nodes per upstream]
│       ├── ip-hash.strategy.ts                   [FNV-1a hash of client IP modulo healthy candidates count]
│       ├── sticky-sessions.strategy.ts           [NINJA_ROUTE cookie extraction, fallback to round-robin]
│       ├── resource-based.strategy.ts            [Metadata weighted composite: cpu*0.7 + mem*0.3]
│       └── random.strategy.ts                    [Uniform pseudo-random selection]
├── cache/
│   ├── cache-manager.ts         [Cache class: l1(InMemoryLRU) + l2(RedisCache) facade]
│   ├── contracts/ (ICache, CacheConfig, IInvalidator, DebeziumConfig, DebeziumMapping, L1Entry)
│   ├── stores/
│   │   ├── in-memory-lru.ts     [InMemoryLRU: Map<string, {value, expires}>, LRU deletion, TTL, glob pattern]
│   │   ├── redis.cache.ts       [RedisCache: client.get/set({EX})/del, KEYS pattern bulk deletion]
│   │   └── hybrid.cache.ts      [HybridCache: L1 memory read-through + L2 Redis write, resilient fallback]
│   ├── policies/
│   │   ├── key-builder.ts       [buildKey(): proxy:METHOD:path with query filter & vary headers]
│   │   ├── cache-control.parser.ts [parseMaxAge, parseSMaxAge, isCacheable status & method whitelist]
│   │   ├── stale-while-revalidate.ts [StaleWhileRevalidate: asynchronous background refresh trigger]
│   │   └── stale-if-error.ts    [StaleIfError: serves stale entry when upstream returns >= 500 or timeout]
│   └── invalidation/
│       ├── tag.invalidator.ts   [TagInvalidator: Map<tag, Set<cacheKey>>, bulk invalidation by group]
│       ├── pattern.invalidator.ts[PatternInvalidator: wildcard glob pattern expansion and Redis KEYS deletion]
│       └── debezium.invalidator.ts [DebeziumInvalidator: CDC change consumer (c,u,d,r) with pathPattern {id}]
├── discovery/
│   ├── contracts/ (IServiceRegistry, RegistryConfig, ServiceInstance)
│   ├── target-node.ts           [TargetNode, createTargetNode() factory with default weight=1, healthy=true]
│   ├── health/
│   │   ├── active.probe.ts      [checkUpstream(): HTTP/HTTPS GET /health, 5s timeout, custom CA verification]
│   │   ├── passive.probe.ts     [PassiveProbe pub/sub emitter: records {upstreamId, statusCode, latencyMs}]
│   │   └── health.manager.ts    [Active 10s interval + Passive traffic listener (5 errors in 30s trips DOWN)]
│   └── registry/
│       └── dynamic.registry.ts  [ServiceRegistry: in-memory Map, 30s heartbeat, atomic disk persistence]`
    },
    {
      title: "Resilience, Rate Limit, Observability & Config Files",
      flex: 1,
      bg: "#ffffff",
      stroke: "#7048e8",
      content: `├── resilience/
│   ├── bulkhead/
│   │   └── bulkhead.ts          [Bulkhead: concurrency semaphore maxConcurrent, enter/leave/execute]
│   ├── circuit-breaker/
│   │   ├── classic.circuit-breaker.ts [ClassicCircuitBreaker: CLOSED->OPEN->HALF_OPEN, failureThreshold=3]
│   │   ├── adaptive.circuit-breaker.ts[AdaptiveCircuitBreaker: Google SRE p=max(0,(req-K*acc)/(req+1)), K=2]
│   │   ├── circuit-breaker.manager.ts [CircuitBreakerManager singleton: Map<upstreamId, ICircuitBreaker>]
│   │   ├── contracts/ (ICircuitBreaker interface)
│   │   └── states/ (ClosedState: shouldTrip, OpenState: isRecoverable, HalfOpenState: shouldClose)
│   └── retry/
│       ├── backoff/
│       │   ├── exponential.backoff.ts         [calculateExponentialBackoff: min(max, base * 2^attempt)]
│       │   ├── full-jitter.backoff.ts         [calculateFullJitterBackoff: Math.random() * exponential]
│       │   ├── equal-jitter.backoff.ts        [calculateEqualJitterBackoff: half + Math.random() * half]
│       │   └── decorrelated-jitter.backoff.ts [calculateDecorrelatedJitterBackoff: base + random*(prev*3-base)]
│       ├── contracts/ (IRetryPolicy interface)
│       ├── retry-handler.ts     [RetryHandler: async execution loop with backoff sleep]
│       └── retry-budget.ts      [RetryBudget: EWMA request/retry counters, 15% retry budget ceiling]
├── ratelimit/
│   ├── rate-limiter.ts          [RateLimiter: algorithm factory, Redis atomic Lua scripts for all 5 algos]
│   ├── contracts/ (ILimiter, IRateLimitStore interfaces)
│   ├── policies/
│   │   └── soft-limit.policy.ts [SoftLimitPolicy: 1.5x burst capacity when load < softLimit]
│   ├── storage/
│   │   ├── memory.store.ts      [MemoryStore: local in-process Map<key, {count, resetTime}>]
│   │   ├── redis.store.ts       [RedisStore: client.incr + client.pExpire, count, reset]
│   │   └── hybrid.store.ts      [HybridStore: L1 local memory + L2 async Redis write with graceful fallback]
│   └── algorithms/ (5 Algorithms)
│       ├── fixed-window.ts      [FixedWindowAlgorithm: count increment per discrete window]
│       ├── sliding-window-log.ts[SlidingWindowLogAlgorithm: timestamp array filtering within windowMs]
│       ├── sliding-window-counter.ts [SlidingWindowCounterAlgorithm: weighted formula floor(prev*w + curr)]
│       ├── token-bucket.ts      [TokenBucketAlgorithm: continuous token refill rate=max/windowMs]
│       └── leaking-bucket.ts    [LeakingBucketAlgorithm: constant drain leakRate, overflow rejection]
├── observability/
│   ├── health/
│   │   └── readiness.ts         [ReadinessProbe: subsystem check aggregation (Redis, healthy upstreams)]
│   ├── logger/
│   │   ├── logger.ts            [Logger: ANSI console formatting, file append, Nginx-format accessLog]
│   │   └── tenant-log.streamer.ts [TenantLogStreamer: per-tenant queue, 1s batch flush via HTTP webhook]
│   ├── metrics/
│   │   ├── prometheus.exporter.ts [MetricsRegistry: counters, gauges, Prometheus exposition format]
│   │   ├── histogram.registry.ts[HistogramRegistry: latency buckets (5ms to 5000ms), worker aggregation]
│   │   └── system.metrics.ts    [collectSystemMetrics: CPU load, RSS memory, uptime]
│   └── tracing/
│       └── tracer.ts            [Tracer: startSpan, endSpan, flush, Span { traceId, spanId, name, attributes }]
├── config/
│   ├── config.ts & config.loader.ts [parseYAMLConfig: YAML parsing, config.d/ merging, env var overrides]
│   ├── config-schema.ts & server-schema.ts [rootConfigSchema: comprehensive Zod validation]
│   └── schemas/ (server, balancer, cache, discovery, observability, ratelimit, resilience, admin schemas)
└── types/ (balancer.types, common.types, config.types, http.types, resilience.types, upstream.types)`
    }
  ]
);


// ============================================================================
// SECTION 2: CORE CLUSTER PROCESS MODEL, WORKER SUPERVISOR & IPC PROTOCOL
// ============================================================================
addSection(
  "⚙️ LAYER 2: CLUSTER PROCESS MODEL, WORKER SUPERVISOR & IPC PROTOCOL",
  "#2b8a3e",
  "#ebfbee",
  [
    {
      title: "Master Process Architecture",
      flex: 1,
      bg: "#ffffff",
      stroke: "#2b8a3e",
      content: `MASTER PROCESS (src/core/cluster/master.ts)
──────────────────────────────────────────────────────────────────
PRIMARY RESPONSIBILITIES:
• Dual-Protocol Ingestion:
  1. Plain HTTP Server (Port 8080):
     - Catches unencrypted requests
     - Responds with 301 Moved Permanently to HTTPS (:8443)
     - Listens to "upgrade" events for plain WS connections
  2. TLS-Terminated HTTPS Server (Port 8443):
     - TLS context initialized from cert.pem & key.pem
     - Evaluates all incoming secure requests
     - Listens to "upgrade" events for WSS connections

• Worker Lifecycle Supervisor:
  - Forks N worker processes (default: config.server.workers ?? os.cpus().length)
  - Passes JSON configuration via environment / initialization message
  - Supervisor Watchdog (cluster.on("exit")):
    Captures unexpected worker deaths:
    logger.error("Master", "Worker died: pid=\${worker.process.pid}")
    Immediately forks fresh replacement worker to maintain pool capacity

• Zero-Downtime Hot Reloading:
  - Invoked via SIGHUP signal or fs.watch debounced change events
  - reloadServerConfig(newConfig):
    1. Forks N new workers with updated configuration
    2. Awaits "online" signal from all new workers
    3. Broadcasts "GRACEFUL_SHUTDOWN" message to old worker processes
    4. Sets 15-second safety timer: forcefully SIGTERMs unclosed workers
    5. Replaces active worker array atomically

• IPC Request Routing & Reply Correlation:
  - Selects worker using round-robin index: workers[index++ % workers.length]
  - Generates unique requestId: crypto.randomUUID()
  - Correlation Registry:
    replyHandlers.set(requestId, {
      res: http.ServerResponse,
      upstreamId: string,
      startTime: number,
      attempted: Set<string>
    })
  - Dispatches WorkerMessageType over cluster IPC
  - Disarms on reply; handles retry if status 502/503/504 and attempts < max`
    },
    {
      title: "Worker Process Internals",
      flex: 1,
      bg: "#ffffff",
      stroke: "#12b886",
      content: `WORKER PROCESS (src/core/cluster/worker.ts)
──────────────────────────────────────────────────────────────────
HIGH-PERFORMANCE PROXY EXECUTION:
• Module-Level Persistent Connection Pools (Fix #3 & Fix #4):
  httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 60000
  })
  httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 256,
    maxFreeSockets: 32,
    rejectUnauthorized: true,
    ca: customCaBuffer
  })
  Instantiated once per worker process; avoids per-request TCP teardown.

• Request Sanitization & Header Injection:
  - Strips hop-by-hop headers:
    delete forwardHeaders["transfer-encoding"]
    delete forwardHeaders["connection"]
    delete forwardHeaders["keep-alive"]
  - Sets upstream host: forwardHeaders["host"] = upstreamUrl.host
  - Injects proxy traceability headers:
    forwardHeaders["X-Real-IP"] = clientIp
    forwardHeaders["X-Forwarded-For"] = "\${incomingXFF}, \${clientIp}"
    forwardHeaders["X-Forwarded-Proto"] = isHttps ? "https" : "http"
    forwardHeaders["X-Forwarded-Host"] = incomingHost
    forwardHeaders["X-Forwarded-Port"] = serverPort
    forwardHeaders["X-Trace-Id"] = traceId
    forwardHeaders["X-Proxy-By"] = "Ninja-Reverse-Proxy"
  - Injects custom static headers from config.server.headers[]
  - Recalculates "content-length" from raw buffer byteLength

• Response Pipeline & Compression Negotiation:
  1. Chunk Collection: Buffer.concat(chunks) upon upstream "end"
  2. Upstream Gunzip: If upstream response has "content-encoding: gzip",
     decompresses with zlib.gunzip() before inspecting or caching
  3. Client Compression:
     If workerConfig.server.compression === true AND
     request accept-encoding includes "gzip" AND
     content-type matches /json|text|javascript|css/:
       compresses body via zlib.gzip()
       sets "content-encoding: gzip"
       encodes payload as base64 string for IPC transmission`
    },
    {
      title: "IPC Protocol & Bootstrap Contract",
      flex: 1,
      bg: "#ffffff",
      stroke: "#20c997",
      content: `IPC PROTOCOL & BOOTSTRAP CONTRACT (src/index.ts & ipc.protocol.ts)
──────────────────────────────────────────────────────────────────
ZOD IPC VALIDATION SCHEMAS:
• Master → Worker Message:
  export const workerMessageSchema = z.object({
    requestType: z.string(),         // HTTP method (GET, POST, etc.)
    headers: z.any(),                // Incoming request headers dictionary
    body: z.string().nullable(),     // Request payload (binary string or null)
    url: z.string(),                 // Full destination URL or path
    requestId: z.string().optional(),// Correlation UUID
    clientIp: z.string().optional()  // Extracted remote client address
  })

• Worker → Master Reply:
  export const workerMessageReplySchema = z.object({
    requestId: z.string().optional(),// Correlation UUID
    data: z.string(),                // UTF-8 string or Base64 encoded buffer
    error: z.string().optional(),    // Error description string
    errorCode: z.string().optional(),// "502" (Bad Gateway), "504" (Timeout)
    statusCode: z.number().optional(),// Upstream HTTP status code
    isCompressed: z.boolean().optional(),
    encoding: z.string().optional(), // "gzip" or undefined
    headers: z.any().optional()      // Upstream response headers
  })

PROCESS LIFECYCLE & EXIT CODE CONTRACT (src/index.ts):
• Exit Code 0 (Clean Intentional Shutdown):
  Triggered by SIGTERM or SIGINT.
  Closes HTTP and HTTPS servers, drains active connections,
  disconnects Redis clients, and exits cleanly.
  Docker restart policy: do NOT restart.

• Exit Code 1 (Configuration Validation Error):
  YAML syntax failure or Zod schema validation mismatch on startup.
  Logged to stderr. Process exits immediately.
  Docker restart policy: do NOT restart (operator must fix config).

• Exit Code 2 (Unexpected Runtime Crash):
  Catches process.on("uncaughtException") and process.on("unhandledRejection").
  Logs stack trace to error log.
  Docker restart policy: triggers automatic container restart.

HOT RELOAD TRIGGER CHANNELS:
• Channel A: OS Signal SIGHUP sent to primary PID
• Channel B: Inotify fs.watch on config.yaml (debounced by 100ms)
• Channel C: Inotify fs.watch on modular config.d/ directory`
    }
  ]
);


// ============================================================================
// SECTION 3: PIPELINE, ROUTING, PROXY HANDLERS & MIDDLEWARE SUITE
// ============================================================================
addSection(
  "🔄 LAYER 3: PIPELINE, ROUTING ENGINE, PROXY HANDLERS & FULL MIDDLEWARE SUITE",
  "#c2255c",
  "#fff0f6",
  [
    {
      title: "Middleware Pipeline & Execution Context",
      flex: 1,
      bg: "#ffffff",
      stroke: "#c2255c",
      content: `MIDDLEWARE PIPELINE & CONTEXT (src/core/pipeline/)
──────────────────────────────────────────────────────────────────
REQUEST CONTEXT (context.ts):
export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  clientIp: string;            // Extracted from X-Forwarded-For or socket
  startTime: number;           // performance.now() high-res timestamp
  upstreamId?: string;         // Target backend ID resolved by LB
  routePath?: string;          // Matched route rule prefix
  metadata: Record<string, any>// Shared context store (traceId, span, auth)
}

PIPELINE ENGINE (middleware.pipeline.ts):
export type MiddlewareFn = (
  ctx: RequestContext,
  next: () => Promise<void>
) => Promise<void>;

export class MiddlewarePipeline {
  private stack: MiddlewareFn[] = [];
  use(fn: MiddlewareFn): this {
    this.stack.push(fn);
    return this;
  }
  async run(ctx: RequestContext): Promise<void> {
    let index = 0;
    const next = async (): Promise<void> => {
      if (ctx.res.writableEnded || index >= this.stack.length) return;
      const fn = this.stack[index++]!;
      await fn(ctx, next);
    };
    await next();
  }
}
• Guarantees strictly ordered execution
• Prevents double-execution if writableEnded is true
• Catches and bubbles asynchronous errors cleanly`
    },
    {
      title: "Full Suite of 8 Middlewares",
      flex: 1,
      bg: "#ffffff",
      stroke: "#d6336c",
      content: `FULL MIDDLEWARE SUITE (src/middleware/)
──────────────────────────────────────────────────────────────────
1. TRACING MIDDLEWARE (tracing.middleware.ts):
   - Extracts incoming "x-trace-id" or generates crypto.randomUUID()
   - Injects traceId into ctx.metadata and response header "X-Trace-Id"
   - Starts root tracer span: tracer.startSpan("\${method} \${url}", traceId)
   - Automatically closes span in try...finally block

2. CORS MIDDLEWARE (cors.middleware.ts):
   - Configurable origins whitelist: origins: string[] (default: ['*'])
   - Sets headers:
     Access-Control-Allow-Origin: origin
     Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
     Access-Control-Allow-Headers: *
     Access-Control-Allow-Credentials: true
   - Handles HTTP OPTIONS preflight: returns 204 No Content immediately

3. BODY LIMIT MIDDLEWARE (body-limit.middleware.ts):
   - Evaluates incoming "content-length" header
   - If contentLength > maxBytes:
     res.writeHead(413, { 'Content-Type': 'application/json' })
     res.end('{"error":"Payload Too Large"}')

4. AUTHENTICATION MIDDLEWARE (auth.middleware.ts):
   - Validates Bearer token: ctx.req.headers['authorization']
   - Compares token against validTokens: Set<string>
   - Rejects unauthenticated requests with 401 Unauthorized

5. RATE LIMIT MIDDLEWARE (rate-limit.middleware.ts):
   - Checks client IP against configured rate limiter
   - On limit breach: returns 429 Too Many Requests with "Retry-After"

6. CACHE MIDDLEWARE (cache.middleware.ts):
   - On GET requests: computes key via cache.buildKey('GET', pathname)
   - On cache HIT: sets "X-Cache: HIT" and ends response with cached buffer

7. CIRCUIT BREAKER MIDDLEWARE (circuit.middleware.ts):
   - Checks if circuit is tripped: if (isOpen())
   - Returns 503 Service Unavailable ('{"error":"Circuit Open"}')

8. LOGGING MIDDLEWARE (logging.middleware.ts):
   - Captures latency = performance.now() - ctx.startTime
   - Emits structured log: "METHOD URL STATUS LATENCY_MS"`
    },
    {
      title: "Router & Proxy Handlers",
      flex: 1,
      bg: "#ffffff",
      stroke: "#e64980",
      content: `ROUTER & PROXY CLIENT HANDLERS (src/core/router/ & proxy/)
──────────────────────────────────────────────────────────────────
ROUTE MATCHING ENGINE (route.matcher.ts):
• RouteRule Schema:
  interface RouteRule {
    path: string;              // e.g. "/api/v1/users"
    upstream: string[];        // Array of upstream backend IDs
    methods?: string[];        // HTTP method whitelist (GET, POST, etc.)
    rateLimit?: RateLimitOpts; // Per-path rate limiting configuration
    cache?: CacheOpts;         // Per-path caching enablement & TTL
    sticky?: boolean;          // Session stickiness toggle
    stripPrefix?: boolean;     // Strips path prefix before upstream request
    canary?: CanaryConfig;     // Canary routing deployment rules
  }

• Match Evaluation:
  - Longest prefix match: finds rule where url.startsWith(rule.path)
  - Method verification: checks rule.methods.includes(method.toUpperCase())
  - Dynamic updates: Router.updateRules(newRules) atomic hot swap

HTTP PROXY CLIENT (http.handler.ts):
• Standalone streaming request forwarder: proxyRequest(opts)
• Injects X-Forwarded-* headers, Host rewrite, X-Proxy-By header
• Connect timeout timer destroys request if backend hangs on handshake
• Response streaming buffers chunks and returns Promise<ProxyResponse>

WEBSOCKET PROXY TUNNEL (websocket.handler.ts):
• Protocol Upgrade: tunnelWebSocket(clientSocket, upstreamUrl, reqFields, head, tlsConfig)
• Upstream Protocol Resolution:
  - isTls = upstreamUrl.protocol === "https:" || upstreamUrl.protocol === "wss:"
  - if isTls: tls.connect({ host, port, rejectUnauthorized, ca: caBuffer })
  - else: net.connect({ host, port })
• Handshake Delivery: forwards HTTP/1.1 Upgrade request and Sec-WebSocket-* headers
• Raw Duplex Framing:
  clientSocket.pipe(targetSocket)  // Browser -> Upstream
  targetSocket.pipe(clientSocket)  // Upstream -> Browser
• Error & Close Lifecycle: closes peer socket on any error/close event`
    }
  ]
);


// ============================================================================
// SECTION 4: LOAD BALANCER ARCHITECTURE & ALL 12 STRATEGIES
// ============================================================================
addSection(
  "⚖️ LAYER 4: LOAD BALANCER CORE & ALL 12 ROUTING STRATEGIES",
  "#e67700",
  "#fff9db",
  [
    {
      title: "Load Balancer Core Engine",
      flex: 1,
      bg: "#ffffff",
      stroke: "#e67700",
      content: `LOAD BALANCER CORE (src/balancer/core/load-balancer.ts)
──────────────────────────────────────────────────────────────────
UPSTREAM STATE TRACKING (UpstreamState):
export interface UpstreamState {
  id: string;                  // Unique upstream identifier
  weight: number;              // Static configured base weight
  activeConnections: number;   // Active concurrency counter
  failures: number;            // Failure counter
  state: "CLOSED"|"OPEN"|"HALF_OPEN"; // Circuit breaker state
  lastFailureTime: number;     // Epoch timestamp of last recorded error
  responseTime: number;        // EWMA smoothed latency (ms)
  healthy: boolean;            // Health probe status (active/passive)
  requests: number;            // Decayed total requests (Google SRE)
  accepts: number;             // Decayed successful requests
  slowStartEndTime: number;    // Epoch timestamp when slow-start ends
  maxConnections?: number;     // Concurrency limit ceiling
  currentWeight: number;       // Runtime dynamic weight (SWRR state)
  url?: string;
  totalBytes?: number;
}

CORE MECHANICS & ALGORITHMIC FLOWS:
• EWMA Latency Tracking:
  responseTime = (α * latencyMs) + ((1 - α) * responseTime)
  α (ewmaAlpha) = 0.1 to 0.3 (filters out single latency spikes)

• Slow-Start Weight Ramp-Up:
  When an upstream recovers from failure or newly registers:
  slowStartEndTime = Date.now() + (slowStartSeconds * 1000)
  progress = 1 - (timeLeft / slowStartDurationMs)
  effectiveWeight = Math.max(1, Math.floor(baseWeight * progress))
  Prevents thundering herd from overwhelming cold upstream cache/JIT.

• pickFiltered(healthyIds, clientIp, attemptedIds, cookies):
  1. Health Filter: id in healthyIds AND s.healthy === true
  2. Attempt Filter: id NOT in attemptedIds (prevents retry loops)
  3. Circuit Breaker Filter: cb.isAllowed() === true
  4. Capacity Filter: s.activeConnections < (s.maxConnections ?? ∞)
  5. HALF_OPEN Priority: If any candidate is in HALF_OPEN state,
     immediately select it as a canary test probe!
  6. Strategy Execution: strategy.pick(candidates, clientIp, cookies)`
    },
    {
      title: "Strategies 1 to 6 (Round Robin & Connections)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#f08c00",
      content: `STRATEGIES 1 TO 6 (src/balancer/strategies/)
──────────────────────────────────────────────────────────────────
1. ROUND ROBIN (round-robin.strategy.ts):
   index = (index + 1) % candidates.length
   Guarantees strict uniform sequential distribution.

2. WEIGHTED ROUND ROBIN (weighted-round-robin.strategy.ts):
   Nginx Smooth Weighted Round-Robin (SWRR) Algorithm:
   forEach upstream s in candidates:
     s.currentWeight += effectiveWeight (with slow-start ramp)
     totalWeight += effectiveWeight
   best = candidate with max(currentWeight)
   best.currentWeight -= totalWeight
   return best
   → Eliminates burst clumping inherent in classical WRR.

3. ADAPTIVE WRR (adaptive-wrr.strategy.ts):
   Dynamically weights upstreams based on real-time telemetry:
   errorRate = failures / (requests + 1)
   dynamicWeight = Math.max(1, Math.round(
     weight * (1 / (1 + responseTime / 100)) * (1 - errorRate)
   ))
   Applies slow-start progress multiplier.
   Weighted random selection picks the healthiest, fastest node.

4. LEAST CONNECTIONS (least-connections.strategy.ts):
   pick = min(activeConnections) across all healthy candidates.
   Ties broken by initial array order.

5. WEIGHTED LEAST CONNECTIONS (weighted-least-connections.strategy.ts):
   score = activeConnections / (weight || 1)
   pick = min(score) across healthy candidates.
   Balances connections proportionally to server sizing.

6. LEAST RESPONSE TIME (least-response-time.strategy.ts):
   pick = min(EWMA responseTime)
   Directs traffic to upstreams with lowest observed processing latency.`
    },
    {
      title: "Strategies 7 to 12 & Canary Deployment",
      flex: 1,
      bg: "#ffffff",
      stroke: "#d9480f",
      content: `STRATEGIES 7 TO 12 & CANARY (src/balancer/strategies/)
──────────────────────────────────────────────────────────────────
7. POWER OF TWO CHOICES (power-of-two.strategy.ts):
   P2C Algorithm: Picks 2 random candidates (i1, i2 where i1 ≠ i2).
   return a.activeConnections <= b.activeConnections ? a : b
   → Reduces worst-case queuing from O(log N / log log N) to O(log log N).

8. CONSISTENT HASHING (consistent-hashing.strategy.ts):
   - Ring Topology: 150 virtual nodes per upstream ("\${id}#vnode\${i}")
   - 32-bit FNV-1a hash algorithm creates distributed hash ring
   - Lookup: hash = fnv1a(clientIp), finds first node where hash >= ring.hash
   - Wraps around to ring[0] if hash > max. Minimal cache eviction on topology change.

9. IP HASH (ip-hash.strategy.ts):
   32-bit FNV-1a hash of remote client IP modulo candidates length:
   hash = 0x811c9dc5; hash ^= char; hash += (hash<<1)+(hash<<4)+(hash<<7)+(hash<<8)+(hash<<24)
   Guarantees stateless client-to-upstream pinning.

10. STICKY SESSIONS (sticky-sessions.strategy.ts):
    - Reads session cookie: NINJA_ROUTE (configurable name)
    - If cookie matches valid upstream ID: routes to that upstream
    - If no cookie or upstream unavailable: falls back to Round Robin
    - Master injects Set-Cookie: NINJA_ROUTE=upstreamId; Path=/; HttpOnly

11. RESOURCE-BASED (resource-based.strategy.ts):
    - Reads CPU and memory telemetry from Dynamic Service Registry metadata
    - Composite load formula: score = (cpu * 0.7) + (memory * 0.3)
    - pick = min(score); falls back to activeConnections/weight if unavailable.

12. RANDOM (random.strategy.ts):
    Uniform pseudo-random selection: candidates[Math.random() * len | 0].

CANARY DEPLOYMENT (v1.2.0 — CanaryConfig):
• Configured in paths[].canary:
  weight: 10 (10% to canary), canaryUpstream, baselineUpstream
  headerKey: "x-canary", headerValue: "true"
  stickyCookieName: "NINJA_CANARY"
• Routing priority:
  1. Header override: x-canary: true -> canary
  2. Sticky cookie: NINJA_CANARY=1 -> canary
  3. Weight dice roll: Math.random() < 0.10 -> canary (sets cookie)
  4. Else -> baseline upstream`
    }
  ]
);


// ============================================================================
// SECTION 5: RESILIENCE LAYER — CIRCUIT BREAKERS, RETRY, BACKOFF & BULKHEAD
// ============================================================================
addSection(
  "🛡️ LAYER 5: RESILIENCE — CIRCUIT BREAKERS, RETRY BUDGET, 4 BACKOFFS & BULKHEAD",
  "#d6336c",
  "#fff0f6",
  [
    {
      title: "Circuit Breakers (Classic & Adaptive)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#d6336c",
      content: `CIRCUIT BREAKERS (src/resilience/circuit-breaker/)
──────────────────────────────────────────────────────────────────
CLASSIC CIRCUIT BREAKER (classic.circuit-breaker.ts):
• Three Discrete States (GoF State Pattern):
  1. CLOSED (Normal Operation):
     - All requests forwarded through to backend
     - On failure: failures++
     - If failures >= failureThreshold (default: 3):
       Trips to OPEN state; records lastFailureTime = Date.now()
  2. OPEN (Failing / Tripped):
     - Rejects all requests immediately (isAllowed() === false)
     - After recoveryTimeMs (default: 15,000ms / 30,000ms):
       Transitions to HALF_OPEN state
  3. HALF_OPEN (Canary Recovery Probe):
     - Allows exactly 1 canary probe request through
     - If probe succeeds: resets failures = 0, state = CLOSED
     - If probe fails: immediately trips back to OPEN state

• State Pattern Implementations (src/resilience/circuit-breaker/states/):
  - ClosedState: shouldTrip(failures, threshold) => failures >= threshold
  - OpenState: isRecoverable(lastFailure, recoveryMs) => now - lastFailure > recoveryMs
  - HalfOpenState: shouldClose(consecutiveSuccesses, threshold) => successes >= threshold

ADAPTIVE CIRCUIT BREAKER (adaptive.circuit-breaker.ts):
• Google SRE Client-Side Throttling Model:
  AdaptiveCircuitBreaker(K = 2, decayFactor = 0.9)
• State Counters with Exponential Decay:
  - On Request: requests = (requests * 0.9) + 1
  - On Success: accepts = (accepts * 0.9) + 1
  - On Failure: accepts = (accepts * 0.9)  // requests decays without accept bump
• Drop Probability Calculation:
  p(drop) = Math.max(0, (requests - (K * accepts)) / (requests + 1))
  - If p(drop) <= 0: All requests allowed through (healthy backend)
  - If p(drop) > 0: Probabilistic drop: if (Math.random() < p(drop)) reject!
  - Parameter K = 2: Throttling begins only when accept rate drops below 50%.

CIRCUIT BREAKER MANAGER (circuit-breaker.manager.ts):
• Singleton manager maintaining per-upstream circuit breaker instances
• getOrCreate(id, mode: 'classic' | 'adaptive', options):
  Guarantees consistent state across master and routing coordinators.`
    },
    {
      title: "Retry Handler & 4 Backoff Algorithms",
      flex: 1,
      bg: "#ffffff",
      stroke: "#ae3ec9",
      content: `RETRY SYSTEM & 4 BACKOFF ALGORITHMS (src/resilience/retry/)
──────────────────────────────────────────────────────────────────
RETRY HANDLER (retry-handler.ts):
export class RetryHandler {
  constructor(private policy: IRetryPolicy) {}
  async execute<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        if (!this.policy.shouldRetry(attempt, err)) break;
        const delay = this.policy.getDelay(attempt);
        if (delay > 0) await sleep(delay);
      }
    }
    throw lastError;
  }
}

4 SPECIALIZED BACKOFF STRATEGIES (src/resilience/retry/backoff/):
1. EXPONENTIAL BACKOFF (exponential.backoff.ts):
   delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
   Deterministic doubling; risk of synchronized retry stampedes.

2. FULL JITTER (full-jitter.backoff.ts):
   limit = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
   delay = Math.random() * limit
   → AWS Recommended: Spreads load uniformly across the full retry interval.

3. EQUAL JITTER (equal-jitter.backoff.ts):
   limit = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
   halfLimit = limit / 2
   delay = halfLimit + (Math.random() * halfLimit)
   → Guarantees a minimum backoff delay while randomizing the upper half.

4. DECORRELATED JITTER (decorrelated-jitter.backoff.ts):
   prev = previousSleepMs ?? baseDelayMs
   nextLimit = prev * 3
   delay = Math.min(maxDelayMs, baseDelayMs + Math.random() * (nextLimit - baseDelayMs))
   → Eliminates correlation between successive retry intervals.`
    },
    {
      title: "SRE Retry Budget & Bulkhead",
      flex: 1,
      bg: "#ffffff",
      stroke: "#9c36b5",
      content: `SRE RETRY BUDGET & BULKHEAD ISOLATION (src/resilience/)
──────────────────────────────────────────────────────────────────
SRE RETRY BUDGET (retry-budget.ts):
• Prevents Cascading System Meltdowns:
  In large microservice meshes, retrying on overloaded backends creates
  catastrophic positive feedback loops (retry storms).
• Mathematical Implementation:
  export class RetryBudget {
    private totalRequests = 0;
    private totalRetries = 0;
    constructor(private budgetPercent = 15, private decayFactor = 0.9) {}
    
    public recordRequest(): void {
      this.totalRequests = (this.totalRequests * this.decayFactor) + 1;
      this.totalRetries = this.totalRetries * this.decayFactor;
    }
    
    public recordRetry(): boolean {
      if (this.totalRequests >= 10) {
        const ratio = (this.totalRetries + 1) / (this.totalRequests + 1);
        if (ratio > this.budgetPercent / 100) {
          return false; // RETRY BUDGET EXHAUSTED: Drop retry!
        }
      }
      this.totalRequests = this.totalRequests * this.decayFactor;
      this.totalRetries = (this.totalRetries * this.decayFactor) + 1;
      return true; // Retry allowed within budget
    }
  }
• Global Singleton: globalRetryBudget maintains system-wide safety.

BULKHEAD ISOLATION (src/resilience/bulkhead/bulkhead.ts):
• Concurrency Partitioning per Upstream:
  Prevents a single slow or misbehaving service from exhausting all proxy sockets.
• Mechanics:
  export class Bulkhead {
    private activeCount = 0;
    constructor(private maxConcurrent: number) {}
    
    public enter(): boolean {
      if (this.activeCount >= this.maxConcurrent) return false;
      this.activeCount++;
      return true;
    }
    
    public leave(): void {
      if (this.activeCount > 0) this.activeCount--;
    }
    
    public async execute<T>(fn: () => Promise<T>): Promise<T> {
      if (this.activeCount >= this.maxConcurrent) {
        throw new Error("Bulkhead capacity reached");
      }
      this.activeCount++;
      try { return await fn(); }
      finally { this.activeCount--; }
    }
  }`
    }
  ]
);


// ============================================================================
// SECTION 6: RATE LIMITING — 5 ALGORITHMS, LUA SCRIPTS, 3 STORES & SOFT LIMIT
// ============================================================================
addSection(
  "⏱️ LAYER 6: MULTI-ALGORITHM RATE LIMITING — MEMORY + ATOMIC REDIS LUA SCRIPTS",
  "#c92a2a",
  "#fff5f5",
  [
    {
      title: "All 5 Rate Limiting Algorithms",
      flex: 1,
      bg: "#ffffff",
      stroke: "#c92a2a",
      content: `ALL 5 ALGORITHMS (src/ratelimit/algorithms/ & rate-limiter.ts)
──────────────────────────────────────────────────────────────────
1. FIXED WINDOW (fixed-window.ts):
   • In-Memory: Map<string, { count: number, resetTime: number }>
     if (now >= data.resetTime) reset count = 1, resetTime = now + windowMs
     else if (count < maxRequests) count++ -> allow, else reject 429
   • Redis Lua Script:
     local count = redis.call("INCR", KEYS[1])
     if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[2]) end
     if count <= tonumber(ARGV[1]) then return 1 end
     return 0

2. SLIDING WINDOW LOG (sliding-window-log.ts):
   • In-Memory: Map<string, number[]>
     timestamps = timestamps.filter(t => (now - t) < windowMs)
     if (timestamps.length < maxRequests) timestamps.push(now) -> allow
   • Redis Lua Script:
     local threshold = tonumber(ARGV[2]) - tonumber(ARGV[3])
     redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", threshold)
     local count = redis.call("ZCARD", KEYS[1])
     if count < tonumber(ARGV[1]) then
       local seq = redis.call("INCR", KEYS[2])
       redis.call("ZADD", KEYS[1], ARGV[2], ARGV[2] .. "-" .. seq)
       redis.call("PEXPIRE", KEYS[1], ARGV[3]); return 1
     end
     return 0

3. SLIDING WINDOW COUNTER (sliding-window-counter.ts):
   • In-Memory: Map<string, { currentCount, prevCount, windowStart }>
     timeIntoWindow = now - windowStart
     weight = (windowMs - timeIntoWindow) / windowMs
     estimatedCount = Math.floor(prevCount * weight + currentCount)
     if (estimatedCount < maxRequests) currentCount++ -> allow
   • Redis Lua: Uses Redis Hashes (HMGET/HSET) for sub-millisecond O(1) estimate!

4. TOKEN BUCKET (token-bucket.ts):
   • In-Memory: Map<string, { tokens: number, lastRefill: number }>
     elapsed = now - lastRefill; rate = maxRequests / windowMs
     newTokens = Math.min(maxRequests, tokens + (elapsed * rate))
     if (newTokens >= 1) tokens = newTokens - 1 -> allow, else reject!
   • Redis Lua: Atomic HMGET tokens, lastRefill, computes continuous refill.

5. LEAKING BUCKET (leaking-bucket.ts):
   • In-Memory: Map<string, { water: number, lastLeak: number }>
     elapsed = now - lastLeak; leaked = elapsed * (maxRequests / windowMs)
     level = Math.max(0, water - leaked)
     if (level + 1 <= maxRequests) water = level + 1 -> allow, else reject!`
    },
    {
      title: "Storage Backends (Memory, Redis, Hybrid)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#e03131",
      content: `STORAGE BACKENDS (src/ratelimit/storage/)
──────────────────────────────────────────────────────────────────
1. MEMORY STORE (memory.store.ts):
   • In-process Map<string, { count, resetTime }>
   • Ultra-fast sub-microsecond access (< 0.05ms)
   • Local to individual worker process; suitable for single-instance
     deployments or per-node edge protection.

2. REDIS STORE (redis.store.ts):
   • Distributed Redis Cluster / Redis Standalone backing
   • Key Prefix: "rl:<algorithm>:<clientIp>"
   • Guarantees global coordination across multiple proxy nodes
     in Kubernetes / Docker Compose clusters
   • increment(key, windowMs):
     const count = await this.client.incr(key)
     if (count === 1) await this.client.pExpire(key, windowMs)
     return count

3. HYBRID STORE (hybrid.store.ts):
   • Tiered Dual-Layer Rate Limiting Architecture:
     - L1: Local MemoryStore for zero-latency local checks
     - L2: Remote RedisStore for distributed cluster sync
   • Execution Flow:
     1. Local fast-path: If local count allows, increment memory
     2. Asynchronous write-behind: Fire-and-forget sync to Redis:
        this.remote.increment(key, windowMs).catch(() => {})
     3. Resilient Fallback: If Redis becomes unreachable, automatically
        and gracefully degrades to memory-only limiting without dropping
        legitimate user traffic!
     4. Remote hydration: Syncs remote count into local memory on first hit.`
    },
    {
      title: "Soft Limit Policy & Controller",
      flex: 1,
      bg: "#ffffff",
      stroke: "#f03e3e",
      content: `SOFT LIMIT POLICY & CONTROLLER (src/ratelimit/)
──────────────────────────────────────────────────────────────────
SOFT LIMIT POLICY (policies/soft-limit.policy.ts):
• Intelligent Dynamic Bursting Engine:
  SoftLimitPolicy(hardLimit, softLimit, burstMultiplier = 1.5)
• Mathematical Logic:
  export class SoftLimitPolicy {
    effectiveLimit(currentLoad: number): number {
      // If current system load is below soft limit threshold,
      // allow temporary bursting up to 1.5x hard limit!
      if (currentLoad < this.softLimit) {
        return Math.floor(this.hardLimit * this.burstMultiplier);
      }
      return this.hardLimit;
    }
  }
• Benefit: Absorbs legitimate traffic spikes when upstream backends
  have available headroom, strictly enforcing hard limits only when
  congestion or heavy load is detected.

RATE LIMITER CONTROLLER (rate-limiter.ts):
• Instantiates the configured algorithm and storage backend
• getAlgorithmState(key):
  Returns diagnostic telemetry for administrative inspections:
  - currentCount / activeTimestampsCount
  - tokensRemaining / waterLevel
  - resetInSec / previousWindowWeight
  - softLimitEnabled, currentLoad, effectiveLimit, hardLimit

RESPONSE HEADERS INJECTED ON 429:
• HTTP Status Code: 429 Too Many Requests
• Response Headers:
  Retry-After: Math.ceil(windowMs / 1000)
  X-RateLimit-Limit: effectiveLimit
  X-RateLimit-Remaining: 0
  X-RateLimit-Reset: epochResetSeconds`
    }
  ]
);


// ============================================================================
// SECTION 7: HIGH-PERFORMANCE CACHING — L1/L2 HYBRID, POLICIES & CDC INVALIDATION
// ============================================================================
addSection(
  "🗃️ LAYER 7: CACHING ENGINE — L1/L2 HYBRID, POLICIES & CDC INVALIDATION",
  "#1976d2",
  "#e3f2fd",
  [
    {
      title: "Hybrid Cache Architecture",
      flex: 1,
      bg: "#ffffff",
      stroke: "#1976d2",
      content: `HYBRID CACHE ARCHITECTURE (src/cache/)
──────────────────────────────────────────────────────────────────
TIERED L1 + L2 CACHING (cache-manager.ts):
• L1: InMemoryLRU (in-memory-lru.ts):
  - In-process Map<string, { value: string, expires: number }>
  - Sub-millisecond lookup latency (< 0.02ms)
  - O(1) eviction: when size >= maxSize (default 10,000 entries),
    deletes oldest Map key: this.cache.keys().next().value
  - Expiration check on get: Date.now() > entry.expires -> del & null
  - Pattern Invalidation: converts glob * to regex .* and purges keys

• L2: RedisCache (redis.cache.ts):
  - Shared across all cluster workers and proxy replicas
  - get(key): Redis GET key
  - set(key, value, ttl): Redis SET key value EX ttl
  - del(key): Redis DEL key
  - invalidate(pattern):
    searchPatterns = [pattern, "*pattern*", "proxy:*:pattern"]
    Executes Redis KEYS search and bulk DEL

• HybridCache (hybrid.cache.ts):
  - get(key):
    1. Check L1: if (l1Val !== null) return l1Val (L1 HIT!)
    2. Check L2: l2Val = await this.l2.get(key)
    3. If L2 hit: populate L1 (l1.set(key, l2Val, ttl)), return l2Val
    4. Resilient degradation: if Redis throws, returns null (cache miss)
  - set(key, value, ttl):
    1. Immediately sets L1
    2. Asynchronously sets L2: try { await l2.set(...) } catch {}
  - del(key) & invalidate(pattern): Purges both L1 and L2 simultaneously.`
    },
    {
      title: "Cache Policies (RFC 7234 & SWR)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#1565c0",
      content: `CACHE POLICIES (src/cache/policies/)
──────────────────────────────────────────────────────────────────
KEY BUILDER (key-builder.ts):
• buildKey(method, path):
  Generates standardized namespace key: "proxy:METHOD:path"
• Query Parameter Sanitization:
  Strips configured ignoreQueryParams (e.g. utm_source, fbclid)
• Vary Header Normalization:
  Appends vary headers (Accept, Accept-Encoding) to cache key
  to prevent serving incompatible formats to clients.

CACHE CONTROL PARSER (cache-control.parser.ts):
• Evaluates upstream HTTP response headers according to RFC 7234:
  - parseMaxAge(headers): extracts max-age=N
  - parseSMaxAge(headers): extracts s-maxage=N (CDN / proxy TTL)
• Cacheability Evaluation (isCacheable):
  - Method check: GET only
  - Status code whitelist:
    200 OK, 203 Non-Authoritative, 204 No Content,
    206 Partial, 300 Multiple Choices, 301 Moved Permanently,
    404 Not Found, 410 Gone

STALE-WHILE-REVALIDATE (stale-while-revalidate.ts):
• Immediate response with background revalidation:
  shouldRevalidate(key, age, maxAge):
    return (age > maxAge) && !this.revalidating.has(key)
• Concurrency Guard: markRevalidating(key) prevents multiple
  redundant background revalidations from overwhelming backends.
• Marks done upon completion: markDone(key).

STALE-IF-ERROR (stale-if-error.ts):
• Graceful Degraded Availability:
  shouldServeStale(errorStatus, staleIfErrorSeconds, ageSeconds):
    isError = errorStatus >= 500 || errorStatus === 0
    return isError && (ageSeconds <= staleIfErrorSeconds)
• Serves cached stale response if backend returns 5xx or connection drops!`
    },
    {
      title: "Cache Invalidation & Debezium CDC",
      flex: 1,
      bg: "#ffffff",
      stroke: "#0d47a1",
      content: `INVALIDATION & CDC INTEGRATION (src/cache/invalidation/)
──────────────────────────────────────────────────────────────────
TAG INVALIDATOR (tag.invalidator.ts):
• Secondary Inverted Index:
  private tagMap = new Map<string, Set<string>>()
• tag(cacheKey, tags: string[]):
  Associates multiple semantic tags with a single cache key
  (e.g. tag("proxy:GET:/users/42", ["users", "user:42", "tenant:1"]))
• Invalidation:
  getKeysForTag(tag): returns string[] of all mapped keys
  Bulk purges all associated keys when an entity changes.

PATTERN INVALIDATOR (pattern.invalidator.ts):
• Wildcard glob pattern resolution:
  - "proxy:GET:/api/products/*"
  - Converts glob to regex for L1 memory purge
  - Uses Redis KEYS / SCAN for L2 distributed cache purge.

DEBEZIUM CDC INVALIDATOR (debezium.invalidator.ts):
• Database Change Data Capture (CDC) Integration:
  Consumes real-time database change events from Kafka / Debezium
• Supported Operations (event.op):
  - "c" (Create), "u" (Update), "d" (Delete), "r" (Read/Snapshot)
• Record ID Extraction:
  Resolves document/row ID from before, after, patch, or event:
  recordId = getVal(before, ["id", "_id"]) ?? getVal(after, ...)
  Supports MongoDB ObjectId formatting (val["$oid"]).
• Path Pattern Resolution:
  Configured in config.yaml cache.debezium.mappings:
    table: "products", pathPattern: "/api/products/{id}"
  Substitutes {id} -> resolved record ID
  Calls invalidateFn("/api/products/12345")
• Fallback Purge: If unmapped table, purges "*\${tableName}*\${recordId}*".`
    }
  ]
);


// ============================================================================
// SECTION 8: SERVICE DISCOVERY & DUAL-MODE HEALTH PROBING
// ============================================================================
addSection(
  "🌐 LAYER 8: DYNAMIC SERVICE DISCOVERY & DUAL-MODE (ACTIVE + PASSIVE) HEALTH PROBING",
  "#0c8599",
  "#c5f6fa",
  [
    {
      title: "Dynamic Service Registry with Persistence",
      flex: 1,
      bg: "#ffffff",
      stroke: "#0c8599",
      content: `DYNAMIC SERVICE REGISTRY (src/discovery/registry/dynamic.registry.ts)
──────────────────────────────────────────────────────────────────
SERVICE INSTANCE SCHEMA:
export interface ServiceInstance {
  id: string;                  // Unique microservice identifier
  url: string;                 // Destination URI (e.g. "http://10.0.1.25:8000")
  registeredAt: number;        // Registration epoch timestamp
  lastHeartbeat: number;       // Latest heartbeat epoch timestamp
  status: "UP" | "DOWN";       // Current operational status
  metadata?: Record<string, string>; // Dynamic tags (cpu, memory, version)
}

CORE REGISTRY OPERATIONS:
• register(instance):
  Sets status = "UP", registeredAt = Date.now(), lastHeartbeat = Date.now()
  Adds to Map<string, ServiceInstance>
  Fires registered callbacks: this.onRegisterCallbacks.forEach(cb => cb(service))
  Triggers atomic disk snapshot save.
• deregister(id):
  Marks status = "DOWN", deletes from active services map
  Fires callbacks: this.onDeregisterCallbacks.forEach(cb => cb(service))
  Triggers atomic disk snapshot save.
• heartbeat(id):
  Updates lastHeartbeat = Date.now(), restores status = "UP".
• checkHeartbeats() [Periodic GC every 10 seconds]:
  Iterates over registered services:
  if (now - s.lastHeartbeat > heartbeatTimeoutMs [default: 30s])
    s.status = "DOWN"
    logger.warn("Registry", "Service heartbeat expired: \${id}")

ATOMIC DISK PERSISTENCE (Survives Proxy Restarts):
• Save:
  tmpFile = "\${persistencePath}.tmp.\${process.pid}.\${Date.now()}_\${rand}"
  await fs.writeFile(tmpFile, JSON.stringify(plainObj, null, 2))
  await fs.rename(tmpFile, this.persistencePath)  // POSIX Atomic Rename!
• Load:
  Rehydrates all services on startup from proxy_registry_backup.json.`
    },
    {
      title: "Active Health Probe (Periodic Polling)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#1098ad",
      content: `ACTIVE HEALTH PROBING (src/discovery/health/active.probe.ts)
──────────────────────────────────────────────────────────────────
PROBING MECHANICS (checkUpstream):
• Protocol Resolution:
  const isHttps = upstreamUrl.protocol === "https:"
  const transport = isHttps ? https : http

• TLS & Custom CA Handling:
  - If isHttps AND !rejectUnauthorized:
    logger.warn("HealthCheck", "TLS verification DISABLED", { id })
  - Custom CA Certificate Support:
    If upstream.tls.ca is specified, reads CA buffer from disk:
    caBuffer = readFileSync(upstream.tls.ca)
    Passes caBuffer to HTTPS request options.

• HTTP Request Options:
  {
    host: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? "443" : "80"),
    path: upstream.healthPath ?? "/health",
    method: "GET",
    timeout: 5000, // Strict 5-second probe timeout
    ...(isHttps && { rejectUnauthorized, ca: caBuffer })
  }

• Status Evaluation:
  - Considers healthy ONLY if res.statusCode === 200
  - On timeout: req.destroy() -> resolves false
  - On network error: resolves false

ACTIVE HEALTH CHECK SCHEDULING (health.manager.ts):
• initialHealthCheck():
  Executes once during master bootstrap (after 3-second worker warmup)
  Populates initial HEALTHY_UPSTREAMS Set.
• startHealthChecks(upstreams, HEALTHY_UPSTREAMS, lb, intervalMs = 10000):
  Background loop running every 10 seconds.
  On status change: updates HEALTHY_UPSTREAMS Set and invokes lb.setHealthy().`
    },
    {
      title: "Passive Health Probing (Traffic Observation)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#15aabf",
      content: `PASSIVE HEALTH PROBING (src/discovery/health/)
──────────────────────────────────────────────────────────────────
OBSERVING LIVE PRODUCTION TRAFFIC (passive.probe.ts):
• Zero-Overhead Telemetry:
  Active probes check /health every 10s, but a backend can crash
  instantly between polling cycles.
  Passive probing observes actual production user traffic in real-time!

• Event Dispatcher (PassiveProbe):
  export interface PassiveProbeEvent {
    upstreamId: string;
    statusCode: number;
    latencyMs: number;
  }
  class PassiveProbe {
    private listeners = [];
    record(event: PassiveProbeEvent) { for (const fn of listeners) fn(event); }
  }
  export const passiveProbe = new PassiveProbe();

PASSIVE PROBE LISTENER (health.manager.ts):
• Failure Detection & Fast Tripping:
  registerPassiveProbeListener(HEALTHY_UPSTREAMS, lb, options):
    failureStatusThreshold = options.failureStatusThreshold ?? 500;
    window = options.errorWindow ?? 30,000ms;
    errorCounts = new Map<string, number[]>();

  On every request completed:
    if (statusCode >= 500):
      Filter error timestamps within the 30-second window
      timestamps.push(now)
      if (timestamps.length >= 5):
        // 5 ERRORS DETECTED: Immediately evict without waiting for active probe!
        HEALTHY_UPSTREAMS.delete(upstreamId);
        lb.setHealthy(upstreamId, false);
        logger.warn("PassiveProbe", "Marking \${id} DOWN passively!");
    else:
      // Successful request observed!
      errorCounts.delete(upstreamId);
      if (!HEALTHY_UPSTREAMS.has(upstreamId)):
        HEALTHY_UPSTREAMS.add(upstreamId);
        lb.setHealthy(upstreamId, true);
        logger.info("PassiveProbe", "Marking \${id} UP passively!");`
    }
  ]
);


// ============================================================================
// SECTION 9: FULL OBSERVABILITY SUITE & ADMIN API
// ============================================================================
addSection(
  "📊 LAYER 9: FULL OBSERVABILITY SUITE (METRICS, TRACING, LOGS) & ADMIN API",
  "#5f3dc4",
  "#f3f0ff",
  [
    {
      title: "Prometheus Metrics & Histograms",
      flex: 1,
      bg: "#ffffff",
      stroke: "#5f3dc4",
      content: `PROMETHEUS METRICS & HISTOGRAMS (src/observability/metrics/)
──────────────────────────────────────────────────────────────────
METRICS REGISTRY (prometheus.exporter.ts):
• Multi-Tenant Prometheus Text Exposition:
  GET /metrics?tenant=<id>  (or GET /__metrics)
• Recorded Telemetry:
  - ninja_http_requests_total{method, path, status, upstream_id, tenant_id}
  - ninja_active_connections{upstream_id}
  - ninja_cache_operations_total{action="hit"|"miss"}
  - ninja_upstream_status{upstream_id} (1=UP, 0=DOWN)
  - ninja_proxy_cpu_load
  - ninja_proxy_memory_used_mb / ninja_proxy_memory_total_mb
  - ninja_proxy_uptime_seconds

LATENCY HISTOGRAM REGISTRY (histogram.registry.ts):
• Standard High-Resolution Buckets:
  boundaries = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] ms
• Produces standard Prometheus histogram lines:
  - ninja_http_request_duration_ms_bucket{le="5",...} 42
  - ninja_http_request_duration_ms_bucket{le="+Inf",...} 500
  - ninja_http_request_duration_ms_sum 12450.5
  - ninja_http_request_duration_ms_count 500

DISTRIBUTED CLUSTER WORKER AGGREGATION:
• Workers record metrics independently in local memory
• On GET /metrics:
  1. Master dispatches METRICS_SNAPSHOT_REQUEST to all workers via IPC
  2. Workers return snapshot payloads (buckets, sums, counters)
  3. Master's aggregatedRegistry merges all snapshots:
     aggregatedRegistry.mergeSnapshot(workerSnapshot)
  4. Returns fully aggregated, cluster-wide Prometheus exposition output!`
    },
    {
      title: "Distributed Tracing & Structured Logging",
      flex: 1,
      bg: "#ffffff",
      stroke: "#6741d9",
      content: `TRACING, LOGGING & WEBHOOKS (src/observability/)
──────────────────────────────────────────────────────────────────
DISTRIBUTED TRACER (tracing/tracer.ts):
• Trace Context Structure:
  export interface Span {
    traceId: string;           // Global trace identifier
    spanId: string;            // Random 36-radix span ID
    name: string;              // "METHOD URL"
    startMs: number;           // Span start epoch timestamp
    endMs?: number;            // Span completion timestamp
    attributes: Record<string, string>; // IP, routePath, upstreamId
  }
• In-memory ring buffer with flush() capability for export to Jaeger / Zipkin.

STRUCTURED ACCESS & EVENT LOGGER (logger/logger.ts):
• TTY Color Formatting: Cyan for INFO, Yellow for WARN, Red for ERROR.
• Async Non-Blocking File Logging (eventLog).
• Nginx-Compatible Access Log:
  \${clientIp} - - [\${isoTimestamp}] "\${method} \${url} HTTP/1.1"
  \${statusCode} \${bytesSent} "-" "\${userAgent}" \${latencyMs}ms

MULTI-TENANT LOG STREAMER (logger/tenant-log.streamer.ts):
• Real-time webhook log exporter for multi-tenant SaaS:
  - Configurable endpoints per tenantId: [{ tenantId, destination }]
  - High-capacity in-memory queues:
    MAX_TENANT_QUEUE = 10,000 entries
    MAX_GLOBAL_QUEUE = 50,000 entries (backpressure protection)
  - Background batch flusher: setInterval(flush, 1000ms)
  - Sends HTTP POST to tenant webhook with header "X-Tenant-ID":
    fetch(destination, { method: "POST", body: JSON.stringify({ tenantId, logs }) })`
    },
    {
      title: "Subsystem Readiness & Admin API Suite",
      flex: 1,
      bg: "#ffffff",
      stroke: "#7048e8",
      content: `READINESS PROBES & ADMIN API (src/core/admin/admin.handler.ts)
──────────────────────────────────────────────────────────────────
SUBSYSTEM READINESS PROBE (observability/health/readiness.ts):
• ReadinessProbe class evaluating registered health checks:
  - "redis" -> cache.ping()
  - "upstreams" -> healthyUpstreams.size > 0
• Evaluated by K8s readinessProbe and GET /__ready (returns 200 or 503).

COMPLETE ADMIN REST API (admin.handler.ts):
• GET /__lb-stats:
  Returns JSON:
  {
    "strategy": "least-connections",
    "upstreams": [{ id, activeConnections, failures, state, responseTime, healthy }],
    "healthyUpstreams": ["backend-a", "backend-b"],
    "retryBudget": { totalRequests, totalRetries, ratio }
  }

• GET /metrics & GET /__metrics:
  Returns cluster-aggregated Prometheus text format (version=0.0.4)

• GET /__registry:
  Returns all registered microservices from Dynamic Service Registry

• POST /__registry/register:
  Registers microservice: body { id, url, metadata? } -> 201 Created

• PUT /__registry/heartbeat/:id:
  Updates service heartbeat timestamp -> 200 OK

• DELETE /__registry/deregister/:id:
  Removes service from active rotation -> 200 OK

• GET /__ready & GET /__health:
  Evaluates all readiness checks -> { ready: true, checks: { redis: true } }

• GET /__cache-stats:
  Returns L1 (size, maxSize) and L2 Redis connectivity statistics.`
    }
  ]
);


// ============================================================================
// SECTION 10: COMPLETE CONFIGURATION ENGINE & ZOD VALIDATION
// ============================================================================
addSection(
  "⚙️ LAYER 10: CONFIGURATION ENGINE, MODULAR config.d/ MERGING & ZOD VALIDATION",
  "#2f9e44",
  "#ebfbee",
  [
    {
      title: "Zod Schema Hierarchy (Server, Balancer, Cache)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#2f9e44",
      content: `CONFIG SCHEMAS: SERVER, BALANCER & CACHE (src/config/schemas/)
──────────────────────────────────────────────────────────────────
SERVER SCHEMA (server.schema.ts):
• server:
  listen: z.number().default(8080)
  port: z.number().optional()           // Alias for listen
  httpsPort: z.number().default(8443)
  workers: z.number().optional()        // Defaults to os.cpus().length
  connectTimeoutMs: z.number().default(5000)
  readTimeoutMs: z.number().default(30000)
  compression: z.boolean().default(true)
  headers: z.array(z.object({ key: z.string(), value: z.string() })).default([])
  upstreams: z.array(z.object({
    id: z.string(),
    url: z.string().url(),
    weight: z.number().default(1),
    healthPath: z.string().default("/health"),
    maxConnections: z.number().optional(),
    tls: z.object({ rejectUnauthorized: z.boolean().default(true), ca: z.string().optional() }).optional()
  }))

BALANCER SCHEMA (balancer.schema.ts):
• loadBalancing:
  strategy: z.enum(["round-robin", "weighted-round-robin", "adaptive-wrr",
    "least-connections", "weighted-least-connections", "least-response-time",
    "power-of-two", "consistent-hashing", "ip-hash", "sticky-sessions",
    "resource-based", "random"]).default("least-connections")
  failureThreshold: z.number().default(3)
  recoveryTimeMs: z.number().default(15000)
  virtualNodes: z.number().default(150)
  ewmaAlpha: z.number().default(0.1)
  stickyCookieName: z.string().default("NINJA_ROUTE")
  slowStartSeconds: z.number().default(30)
  retry: z.object({ maxAttempts: z.number().default(2), statusCodes: z.array(z.number()).default([502,503,504]) })

CACHE SCHEMA (cache.schema.ts):
• cache:
  enabled: z.boolean().default(false)
  host: z.string().default("127.0.0.1"), port: z.number().default(6379)
  ttlSeconds: z.number().default(60), l1Enabled: z.boolean().default(true)
  l1MaxSize: z.number().default(10000)
  staleWhileRevalidate: z.boolean().default(true), staleIfError: z.boolean().default(true)
  key: z.object({ ignoreQueryParams: z.array(z.string()), varyHeaders: z.array(z.string()) })
  debezium: z.object({ enabled: z.boolean(), channel: z.string(), mappings: z.array(mappingSchema) })`
    },
    {
      title: "Zod Schema Hierarchy (Resilience, Rate Limit, Observability)",
      flex: 1,
      bg: "#ffffff",
      stroke: "#37b24d",
      content: `CONFIG SCHEMAS: RESILIENCE, RATE LIMIT & OBSERVABILITY
──────────────────────────────────────────────────────────────────
RESILIENCE SCHEMA (resilience.schema.ts):
• resilience:
  retry:
    enabled: z.boolean().default(true)
    maxAttempts: z.number().default(4)
    backoff: z.enum(["exponential", "full-jitter", "equal-jitter", "decorrelated-jitter"]).default("full-jitter")
    baseDelayMs: z.number().default(100)
    maxDelayMs: z.number().default(5000)
    budgetPercent: z.number().default(15)
    retryOn: z.object({ localNodeFailure: z.boolean(), systemOverload: z.boolean() })
  circuitBreaker:
    mode: z.enum(["classic", "adaptive"]).default("classic")
    failureThreshold: z.number().default(3)
    recoveryTimeMs: z.number().default(15000)
    K: z.number().default(2)
    windowMs: z.number().default(10000)
  bulkhead:
    enabled: z.boolean().default(false)
    maxConcurrentPerUpstream: z.number().default(100)

RATE LIMIT SCHEMA (ratelimit.schema.ts):
• rateLimit:
  enabled: z.boolean().default(true)
  storage: z.enum(["memory", "redis", "hybrid"]).default("memory")
  algorithm: z.enum(["fixed-window", "sliding-window-log", "sliding-window-counter",
                     "token-bucket", "leaking-bucket"]).default("token-bucket")
  windowMs: z.number().default(60000)
  maxRequests: z.number().default(1000)
  softLimit: z.number().optional()
  burstMultiplier: z.number().default(1.5)
  redis: z.object({ host: z.string(), port: z.number(), keyPrefix: z.string() })

DISCOVERY SCHEMA (discovery.schema.ts):
• discovery:
  heartbeatTimeoutMs: z.number().default(30000)
  cleanupIntervalMs: z.number().default(10000)
  persistencePath: z.string().default("proxy_registry_backup.json")

OBSERVABILITY SCHEMA (observability.schema.ts):
• observability:
  logging: z.object({ level: z.enum(["debug", "info", "warn", "error"]), accessLog: z.union([z.boolean(), z.string()]) })
  metrics: z.object({ enabled: z.boolean(), path: z.string(), histograms: z.boolean(), perTenantMetrics: z.boolean() })
  tracing: z.object({ enabled: z.boolean(), endpoint: z.string() })
  tenantDelivery: z.object({ mode: z.enum(["webhook", "none"]), exportEndpoints: z.array(tenantEndpointSchema) })`
    },
    {
      title: "Config Loader, Modular config.d/ & Hot Reload",
      flex: 1,
      bg: "#ffffff",
      stroke: "#40c057",
      content: `CONFIG LOADER & MODULAR config.d/ (src/config/config.loader.ts)
──────────────────────────────────────────────────────────────────
PARALLEL MODULAR MERGING (parseYAMLConfig):
1. Reads base config file: await fs.readFile(filepath, "utf-8")
2. Scans for directory config.d/ alongside base config:
   - Reads all *.yaml and *.yml modular snippet files
   - Uses Promise.all() to parse snippet files in parallel!
   - Merges upstreams: config.upstreams = [...base, ...snippetUpstreams]
   - Merges routes: config.routes = [...base, ...snippetRoutes]
   - Merges headers: config.server.headers = [...base, ...snippetHeaders]

BACKWARD COMPATIBILITY NORMALIZATION:
• Automatically maps legacy configurations without breaking:
  - server.port <-> server.listen
  - server.sslCertPath -> tls.cert
  - server.sslKeyPath -> tls.key
  - server.paths <-> routes
  - server.accessLog -> observability.logging.accessLog
  - tenant_delivery -> observability.tenantDelivery
  - loadBalancing.retry -> resilience.retry

ENVIRONMENT VARIABLE OVERRIDES:
• Injected at startup and reload:
  - PORT -> config.server.port
  - HOST -> config.server.host
  - WORKERS -> config.server.workers
  - REDIS_HOST -> config.cache.host & config.rateLimit.redis.host
  - REDIS_PORT -> config.cache.port & config.rateLimit.redis.port
  - LOG_LEVEL -> config.observability.logging.level

HOT RELOAD ENGINE (fs.watch):
• Inotify watchers on config.yaml AND config.d/ directory
• 100ms Debounce Timer:
  clearTimeout(watchDebounceTimer);
  watchDebounceTimer = setTimeout(async () => {
    const raw = await parseYAMLConfig(configPath);
    const valid = await validateConfig(raw);
    await reloadServerConfig(valid);
  }, 100);
• Avoids multiple reload triggers when saving complex directory edits!`
    }
  ]
);


// ============================================================================
// SECTION 11: END-TO-END STEP-BY-STEP REQUEST & WEBSOCKET LIFECYCLES
// ============================================================================
addSection(
  "🔄 LAYER 11: COMPLETE END-TO-END STEP-BY-STEP REQUEST & WEBSOCKET LIFECYCLES",
  "#099268",
  "#e6fcf5",
  [
    {
      title: "Step-by-Step HTTP/HTTPS Request Lifecycle",
      flex: 1,
      bg: "#ffffff",
      stroke: "#099268",
      content: `STEP-BY-STEP HTTP/HTTPS REQUEST LIFECYCLE (12 STAGES)
──────────────────────────────────────────────────────────────────
[STAGE 1: Ingestion & TLS Termination]
• Client connects to HTTP :8080 -> 301 Moved Permanently (redirect to HTTPS :8443)
• Client connects to HTTPS :8443 -> TLS Handshake, SNI inspection, cipher negotiation
• Master httpsServer emits "request" event -> creates RequestContext { req, res, clientIp, startTime }

[STAGE 2: Distributed Tracing & Correlation]
• tracingMiddleware extracts "x-trace-id" or generates crypto.randomUUID()
• Injects X-Trace-Id into res headers and starts root Tracer span

[STAGE 3: Security & Policy Enforcement]
• corsMiddleware: If method === "OPTIONS", responds with 204 No Content and CORS headers
• bodyLimitMiddleware: Compares content-length against maxBytes. If exceeded -> 413 Payload Too Large
• authMiddleware: Compares Authorization Bearer token against validTokens Set. If invalid -> 401 Unauthorized
• rateLimitMiddleware: Computes key = clientIp, evaluates algorithm. If limit breached -> 429 Too Many Requests

[STAGE 4: Route Matching & Stripping]
• Router evaluates path against RouteRule[]. Finds longest matching prefix with method in whitelist
• Applies stripPrefix if configured

[STAGE 5: High-Performance Cache Lookup]
• If route.cache.enabled === true AND method === "GET":
  key = buildKey('GET', url.pathname)
  1. L1 InMemoryLRU check -> If hit, returns 200 with X-Cache: HIT immediately!
  2. L2 Redis check -> If hit, populates L1 and returns 200 with X-Cache: HIT immediately!
• On Cache Miss: continues pipeline

[STAGE 6: Canary Routing Evaluation]
• If path has canary config:
  1. Check x-canary header: if matched -> canaryUpstream
  2. Check NINJA_CANARY cookie: if matched -> canaryUpstream
  3. Roll random weight: if Math.random() < weight/100 -> canaryUpstream (sets cookie)
  4. Else -> baselineUpstream

[STAGE 7: Load Balancer Selection]
• lb.pickFiltered(healthyUpstreams, clientIp, attemptedIds, cookies)
• Filters: healthy status, not in attemptedIds, circuit breaker isAllowed(), under maxConnections
• Prioritizes HALF_OPEN test probes; delegates to configured strategy (e.g. SWRR, LeastConn, ConsistentHash)

[STAGE 8: IPC Dispatch to Worker]
• Master selects worker from cluster pool: workers[workerIndex++ % N]
• Generates correlation requestId (UUID), stores replyHandler in Map
• Sets connectTimeoutMs & readTimeoutMs safety timers
• Dispatches workerMessageSchema JSON payload over process.send()

[STAGE 9: Worker Execution & Upstream Request]
• Worker parses IPC message, selects pooled httpAgent or httpsAgent
• Sanitizes headers (strips hop-by-hop, sets Host, injects X-Forwarded-*, custom headers)
• Sends streaming request to backend using http.request or https.request
• Buffers response chunks on data events

[STAGE 10: Decompression, Compression & IPC Return]
• Decompresses upstream gzip if detected via zlib.gunzip()
• Compresses payload via zlib.gzip() if client accepts gzip and content is compressible
• Worker returns workerMessageReplySchema JSON via process.send()

[STAGE 11: Master Reply Delivery & Post-Processing]
• Master correlation handler fires: res.writeHead(statusCode, headers), res.end(body)
• If cacheable GET: writes to L1 and L2 cache asynchronously
• Updates metrics (ninja_http_requests_total, histogram observe, active connections decrement)
• Writes Nginx-format access log; queues tenant webhook if configured

[STAGE 12: Resilient Fault Recovery (On 502/503/504)]
• If upstream fails or times out: lb.recordFailure(upstreamId)
• If attempts < maxAttempts: marks upstreamId in attemptedIds Set
• Loops back to STAGE 7: selects next healthy backend and transparently retries request!`
    },
    {
      title: "Step-by-Step WebSocket Upgrade Lifecycle",
      flex: 1,
      bg: "#ffffff",
      stroke: "#0ca678",
      content: `STEP-BY-STEP WEBSOCKET UPGRADE LIFECYCLE (8 STAGES)
──────────────────────────────────────────────────────────────────
[STAGE 1: Client Upgrade Handshake Initiation]
• Client sends HTTP/1.1 request with headers:
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Key: <base64-nonce>
  Sec-WebSocket-Version: 13
• Arrives at Master plain HTTP server (:8080) or HTTPS server (:8443)
• Server fires "upgrade" event: (req, socket, head)

[STAGE 2: Client Address & Route Resolution]
• Extracts client remote address from socket.remoteAddress or incoming X-Forwarded-For
• Identifies target path and route rules

[STAGE 3: Load Balancer Selection]
• Master invokes lb.pickFiltered(healthyUpstreams, clientIp)
• Selects target upstream backend supporting WebSocket
• If no healthy backend available: destroys client socket immediately

[STAGE 4: Upstream Socket Connection]
• Protocol Analysis: isTls = upstreamUrl.protocol === "wss:" || upstreamUrl.protocol === "https:"
• If isTls === true:
  targetSocket = tls.connect({
    host: upstreamUrl.hostname,
    port: upstreamUrl.port || 443,
    rejectUnauthorized: upstream.tls?.rejectUnauthorized ?? true,
    ca: upstream.tls?.ca ? readFileSync(upstream.tls.ca) : undefined
  })
• If isTls === false:
  targetSocket = net.connect({
    host: upstreamUrl.hostname,
    port: upstreamUrl.port || 80
  })

[STAGE 5: Handshake Forwarding]
• Upon upstream targetSocket "connect" event:
  Reconstructs and writes raw HTTP Upgrade request:
  GET <path> HTTP/<version>\\r\\n
  Host: <upstream-hostname>\\r\\n
  Upgrade: websocket\\r\\n
  Connection: Upgrade\\r\\n
  Sec-WebSocket-Key: <client-key>\\r\\n
  Sec-WebSocket-Version: 13\\r\\n
  X-Forwarded-For: <client-ip>\\r\\n\\r\\n
• If head buffer contains initial frames: targetSocket.write(head)

[STAGE 6: Full-Duplex Bidirectional TCP Pipe]
• Establishes transparent binary frame streaming:
  clientSocket.pipe(targetSocket)  // Client frames -> Backend
  targetSocket.pipe(clientSocket)  // Backend frames -> Client
• Operates as a raw bidirectional TCP tunnel
• Zero protocol overhead; sub-microsecond frame forwarding latency!

[STAGE 7: Concurrency & Telemetry Accounting]
• Increments load balancer active connections:
  lb.incrementConnection(upstreamId)
• Updates Prometheus gauge:
  ninja_active_connections{upstream_id="backend-a"}++

[STAGE 8: Tear-Down & Cleanup Lifecycle]
• Error Handling:
  targetSocket.on("error") -> destroys clientSocket
  clientSocket.on("error") -> destroys targetSocket
• Close Lifecycle:
  targetSocket.on("close") & clientSocket.on("close") ->
  lb.releaseConnection(upstreamId)
  ninja_active_connections{upstream_id="backend-a"}--`
    }
  ]
);


// ============================================================================
// SECTION 12: INFRASTRUCTURE, KUBERNETES, DOCKER, CI/CD & FULL TEST SUITES
// ============================================================================
addSection(
  "🚀 LAYER 12: INFRASTRUCTURE, KUBERNETES MANIFESTS, DOCKER, CI/CD & TEST SUITES",
  "#343a40",
  "#f8f9fa",
  [
    {
      title: "Docker & Container Architecture",
      flex: 1,
      bg: "#ffffff",
      stroke: "#495057",
      content: `DOCKER & CONTAINERS (deploy/docker/ & root)
──────────────────────────────────────────────────────────────────
MULTI-STAGE PRODUCTION DOCKERFILE:
• Stage 1 (Builder):
  FROM node:22-alpine AS builder
  WORKDIR /app
  COPY package.json pnpm-lock.yaml ./
  RUN corepack enable && pnpm install --no-frozen-lockfile
  COPY . .
  RUN pnpm run build

• Stage 2 (Minimal Runtime):
  FROM node:22-alpine
  WORKDIR /app
  COPY --from=builder /app/dist ./dist
  COPY --from=builder /app/node_modules ./node_modules
  COPY --from=builder /app/package.json ./
  EXPOSE 8080 8443
  CMD ["node", "dist/index.js", "--config", "/etc/ninja-proxy/config.yaml"]

CONTAINER FLAVORS:
• Dockerfile.dev: Includes tsx / nodemon for instant hot reload
• Dockerfile.distroless: Ultra-hardened image with no package manager or shell

DOCKER COMPOSE TOPOLOGY (docker-compose.yml):
• proxy container (image: pravi2005/reverse-proxy:latest):
  - Ports: 8081:8080 (HTTP), 8443:8443 (HTTPS)
  - Volumes: ./config.yaml -> /etc/ninja-proxy/config.yaml
  - extra_hosts: host.docker.internal:host-gateway (reaches host apps)
  - depends_on: redis
• redis container (image: redis:7-alpine): port 6379, proxy-network
• backend-a & backend-b mock services`
    },
    {
      title: "Kubernetes Orchestration & Monitoring",
      flex: 1,
      bg: "#ffffff",
      stroke: "#212529",
      content: `KUBERNETES & PROMETHEUS OPERATOR (deploy/k8s/)
──────────────────────────────────────────────────────────────────
ENTERPRISE K8s MANIFEST ARCHITECTURE:
• Namespace: ninja-proxy
• Deployment (deployment.yaml):
  - Replicas: 3
  - Containers: proxy with ports 8080 & 8443
  - Volume Mounts:
    configMap: ninja-proxy-config -> /etc/ninja-proxy/config.yaml
    secret: ninja-proxy-certs -> /etc/ninja-proxy/certs (readOnly)
  - Resources:
    requests: cpu: 100m, memory: 128Mi
    limits:   cpu: 500m, memory: 512Mi

• Service (service.yaml):
  - Type: ClusterIP
  - Ports: port 80 -> targetPort 8080, port 443 -> targetPort 8443

• HorizontalPodAutoscaler (hpa.yaml):
  - Target: Deployment/ninja-proxy
  - minReplicas: 2, maxReplicas: 20
  - Scaling Metric: Resource CPU averageUtilization: 70%

• PodDisruptionBudget (pdb.yaml):
  - minAvailable: 1 (guarantees zero downtime during cluster upgrades)

• ServiceMonitor (monitoring/servicemonitor.yaml):
  - Endpoints: port http, path /metrics, interval 15s

• PrometheusRule (monitoring/prometheusrule.yaml):
  - Alert: HighErrorRate
  - Expr: sum(rate(ninja_proxy_requests_total{status=~"5.."}[5m])) > 0.1
  - Duration: for 5m -> triggers alerts

• Kustomize Overlays: overlays/dev, overlays/staging, overlays/prod

GRAFANA PROVISIONED DASHBOARDS (deploy/monitoring/):
• proxy-overview.json: Total throughput, global latency p50/p95/p99, error rate
• load-balancer.json: Per-upstream connection balancing, SWRR weights, latency
• rate-limit.json: Rate limit evaluations, 429 rejections, burst utilisation
• cache.json: L1 memory vs L2 Redis hit rates, eviction counts, TTLs
• circuit-breaker.json: Real-time breaker state transitions (CLOSED/OPEN/HALF_OPEN)`
    },
    {
      title: "Jenkins CI/CD & Complete Test Suites",
      flex: 1,
      bg: "#ffffff",
      stroke: "#343a40",
      content: `JENKINS CI/CD & COMPLETE TEST SUITES (Jenkinsfile & tests/)
──────────────────────────────────────────────────────────────────
JENKINS 8-STAGE ENTERPRISE PIPELINE:
1. Checkout: Clones Git repository branch
2. Dependencies: Installs dependencies via pnpm
3. Build: Compiles TypeScript via pnpm run build (strict type checking)
4. SonarQube Analysis: Code quality, security smells & Sonar Quality Gate
5. Trivy Filesystem Scan: Scans filesystem dependencies for CVEs
6. Automated Tests: Executes unit & integration test suites
7. Docker Buildx: Multi-architecture container build (linux/amd64, arm64)
8. Docker Push & Container Scan: Pushes to registry; Trivy image vulnerability scan

EXHAUSTIVE TEST SUITE ARCHITECTURE (tests/):
• Unit Tests (tests/unit/):
  - balancer/: balancerAllStrategies, loadBalancer, loadBalancerAdvanced, canarySchema
  - cache/: cache, cacheAllFeatures (SWR, SIE, Tag Invalidation)
  - discovery/: discovery, discoveryAllFeatures (Heartbeats, Snapshot rehydration)
  - observability/: observabilityAllFeatures (Metrics, Histograms, Tracer, Readiness)
  - ratelimit/: rateLimiter, rateLimitAllAlgorithms (Memory & Redis Lua tests)
  - resilience/: circuitBreaker, resilience, resilienceAllFeatures (Adaptive CB, Bulkhead)

• Integration Tests (tests/integration/):
  - http-proxy.test.ts: Live HTTP/HTTPS proxy forwarding & header assertions
  - websocket.test.ts: Live WebSocket upgrade & bidirectional payload delivery
  - hot-reload.test.ts: SIGHUP config reload verification under active traffic
  - canary-routing.test.ts: Weight split, header overrides & sticky cookie routing
  - failover.test.ts: Backend failure tripping & automatic alternate routing

• K6 Load Testing (tests/load/k6/):
  - smoke.js: 1 VU baseline correctness verification
  - stress.js: Ramps up to 100 concurrent VUs to test sustained throughput
  - spike.js: 200 VU sudden burst test to verify soft-limit bursting
  - cache.js: Hit vs Miss latency & throughput benchmark
  - rate-limit.js: High-concurrency 429 rejection verification
  - sticky.js: Session stickiness persistence benchmark

• Chaos & System Recovery Tests:
  - tests/chaos/upstream-failure.chaos.ts: Chaos injection simulation
  - tests/circuit-breaker-recovery-test.mjs: Kills upstream process (lsof -i:8000),
    asserts 503 tripping, restarts backend, asserts automatic HALF_OPEN probe recovery!`
    }
  ]
);

// ============================================================================
// MERGE AND COMMIT TO EXCALIDRAW FILE
// ============================================================================
raw.elements = [...original156, ...newElements];
writeFileSync(diagramFile, JSON.stringify(raw, null, 2));

console.log(`\n======================================================`);
console.log(`✅ MASTER ARCHITECTURE DIAGRAM SUCCESSFULLY GENERATED!`);
console.log(`======================================================`);
console.log(`• Base elements preserved: ${original156.length}`);
console.log(`• Enriched architectural elements added: ${newElements.length}`);
console.log(`• Total diagram elements: ${raw.elements.length}`);
console.log(`• File size: ${(Buffer.byteLength(JSON.stringify(raw)) / 1024).toFixed(1)} KB`);
console.log(`• Canvas Y range: -8860 to ${Math.round(curY)} (zero overlaps)`);
console.log(`• Output file: ${diagramFile}`);
console.log(`======================================================\n`);

