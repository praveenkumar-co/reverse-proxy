#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

function uid() { return randomBytes(8).toString('base64url').slice(0, 10); }

function rect(x, y, w, h, opts = {}) {
  return {
    id: uid(), type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: opts.strokeColor || '#1e1e1e',
    backgroundColor: opts.bg || 'transparent',
    fillStyle: 'solid', strokeWidth: opts.sw || 2, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null,
    index: 'b' + uid(), roundness: { type: 3 },
    seed: Math.floor(Math.random() * 1e9), version: 1,
    versionNonce: Math.floor(Math.random() * 1e9), isDeleted: false,
    boundElements: [], updated: Date.now(), link: null, locked: false, created: null,
  };
}

function txt(x, y, content, opts = {}) {
  const lines = content.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length));
  const w = opts.w || Math.max(maxLen * 7.5, 200);
  const h = opts.h || lines.length * 20 + 10;
  return {
    id: uid(), type: 'text', x, y, width: w, height: h, angle: 0,
    strokeColor: opts.color || '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null,
    index: 'b' + uid(), roundness: null,
    seed: Math.floor(Math.random() * 1e9), version: 1,
    versionNonce: Math.floor(Math.random() * 1e9), isDeleted: false,
    boundElements: [], updated: Date.now(), link: null, locked: false, created: null,
    text: content, fontSize: opts.fontSize || 14, fontFamily: 3,
    textAlign: 'left', verticalAlign: 'top', containerId: null,
    originalText: content, autoResize: true, lineHeight: 1.25,
  };
}

const filePath = 'docs/ninja-rp-new-diagram.excalidraw';
const diagram = JSON.parse(readFileSync(filePath, 'utf8'));
const existing = diagram.elements;
console.log(`Loaded ${existing.length} existing elements`);

const N = [];

// ─── A: WORKER INTERNALS ──────────────────────────────────────────────────────
const WX = 10615, WY = -2050;
N.push(rect(WX-10, WY-30, 5900, 1180, { bg:'#e7f5ff', strokeColor:'#1971c2', sw:3 }));
N.push(txt(WX, WY, '⚙  WORKER PROCESS INTERNALS  (src/core/worker.ts)', { fontSize:18, color:'#1971c2', w:5880 }));

N.push(rect(WX+10, WY+50, 1700, 510, { bg:'#fff9db', strokeColor:'#e67700' }));
N.push(txt(WX+20, WY+60,
`WORKER BOOTSTRAP
─────────────────────────────────
process.on("message", handler)
  → msg.type === "REQUEST"

httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000
})
httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true
  ca: fs.readFileSync(caPath) if custom CA
})

Created ONCE at module level (FIX#4)
NOT per-request (was bug in Phase 1)`, { w:1680, h:500 }));

N.push(rect(WX+1750, WY+50, 1800, 510, { bg:'#f3f0ff', strokeColor:'#6741d9' }));
N.push(txt(WX+1760, WY+60,
`RATE LIMITER  (middleware/rate-limiter.ts)
──────────────────────────────────────────
clientIP = req.headers["x-forwarded-for"]
        || req.socket.remoteAddress

1. FIXED WINDOW:
   fwMap.get(ip) → {count, windowStart}
   if now - windowStart > windowMs → reset
   if count >= limit → 429

2. SLIDING WINDOW:
   swMap.get(ip) → {timestamps: number[]}
   filter timestamps > (now - windowMs)
   if filtered.length >= limit → 429
   else push(now)

3. TOKEN BUCKET:
   toMap.get(ip) → {tokens, lastRefill}
   elapsed = now - lastRefill
   refill = elapsed/refillMs * refillRate
   tokens = Math.min(capacity, t+refill)
   if tokens < 1 → 429  else tokens--`, { w:1780, h:500 }));

N.push(rect(WX+3590, WY+50, 2280, 510, { bg:'#fff0f6', strokeColor:'#c2255c' }));
N.push(txt(WX+3600, WY+60,
`PROXY REQUEST HANDLER  (worker.ts → handleRequest)
────────────────────────────────────────────────────
IPC msg: { type:"REQUEST", payload, requestId, clientIP }

url = new URL(payload.url, upstreamBase)
isHttps = upstream.url.startsWith("https://")
options = {
  hostname, port, path, method,
  headers: {
    ...req.headers,
    "x-forwarded-for": clientIP,
    "x-real-ip": clientIP,
    "x-ninja-proxy": "1.0"
  },
  agent: isHttps ? httpsAgent : httpAgent,
  timeout: config.server.timeout || 30000
}
transport = isHttps ? https : http
transport.request(options, (upstreamRes) => {
  chunks[] → Buffer.concat()
  content-encoding → gunzip/brotli if needed
  process.send({type:"RESPONSE", requestId,
    status, headers, body})
})
req.setTimeout(t, () →
  process.send({type:"TIMEOUT", requestId}))
  Master → 504 Gateway Timeout`, { w:2260, h:500 }));

N.push(rect(WX+10, WY+600, 5860, 270, { bg:'#ebfbee', strokeColor:'#2f9e44' }));
N.push(txt(WX+20, WY+610,
`RESPONSE PIPELINE  (worker → master → client)
──────────────────────────────────────────────────────────────────────────────────────────────
1. Chunk collection: upstream.on("data", chunk → chunks.push(chunk)) → "end" → Buffer.concat(chunks)
2. Encoding detect:  upstreamRes.headers["content-encoding"] → "gzip" | "br" | "deflate" | undefined
3. Decompress:       zlib.gunzipSync(body) | zlib.brotliDecompressSync(body) | zlib.inflateSync(body)
4. IPC send:         process.send({ type:"RESPONSE", requestId, status, headers, body:body.toString("base64") })
5. Master receives:  replyHandler(requestId) → res.writeHead(status, headers) → res.end(Buffer.from(body,"base64"))
6. Cache write:      if MISS + status 200 → Redis SET buildKey(method,url) body EX ttlSeconds
7. Metrics:          recordRequest(method, path, status, upstreamId, durationMs)`, { w:5840, h:250 }));

// ─── B: ALL LB ALGORITHMS ─────────────────────────────────────────────────────
const LBX = 9455, LBY = -4000;
N.push(rect(LBX-10, LBY-30, 1020, 1420, { bg:'#fff9db', strokeColor:'#e67700', sw:3 }));
N.push(txt(LBX, LBY, '🔀  LB ALGORITHMS — DEEP DIVE\n(src/services/load-balancer.ts)', { fontSize:16, color:'#e67700', w:1000 }));
N.push(txt(LBX+10, LBY+55,
`SMOOTH WEIGHTED ROUND-ROBIN (Nginx algo):
──────────────────────────────────────────
Each upstream has:
  weight          (static, from config)
  effectiveWeight (CB-adjusted at runtime)
  currentWeight   (starts at 0)

Per pick():
  forEach upstream:
    currentWeight += effectiveWeight
  best = upstream with max currentWeight
  best.currentWeight -= sum(effectiveWeights)
  return best

CB integration:
  failure → effectiveWeight = max(0, ew-1)
  success → effectiveWeight = min(w, ew+1)

LEAST CONNECTIONS:
──────────────────
lb.activeConns Map<id, number>
pick = min(activeConns) among HEALTHY
ties broken by array index

IP HASH (FNV-1 32-bit):
────────────────────────
hash = 2166136261 (offset basis)
for char in clientIP:
  hash ^= charCode
  hash = (hash * 16777619) >>> 0
idx = hash % HEALTHY.length
→ same IP always hits same upstream

RANDOM:
───────
Math.random() * HEALTHY.length | 0

CONSISTENT HASH (Virtual Nodes):
──────────────────────────────────
ring = sorted Map<hash, upstream>
150 virtual nodes per upstream:
  fnv1("id:0")..."id:149" → insert
lookup(clientIP):
  h = fnv1(clientIP)
  ceiling entry in ring → upstream
  wraps if h > max ring value

LEAST BANDWIDTH:
─────────────────
lb.bytesMap Map<id, totalBytes>
pick = min(bytesMap) among HEALTHY
Updated per response by worker

RESOURCE-BASED:
────────────────
GET /health returns { cpu:%, mem:% }
score = cpu + mem (composite)
pick = min(score) among HEALTHY

CANARY (v1.2.0 — 90/10 split):
────────────────────────────────
1. Header: x-canary:"true" → canary up
2. Cookie: NINJA_CANARY=1  → canary up
3. else: Math.random()<0.10 → canary
Set-Cookie: NINJA_CANARY=1 (sticky)
Stable: weight=90, Canary: weight=10`, { w:1000, h:1350 }));

// ─── C: REQUEST LIFECYCLE ─────────────────────────────────────────────────────
const RLX = 10615, RLY = -700;
N.push(rect(RLX-10, RLY-30, 6200, 1060, { bg:'#f8f9fa', strokeColor:'#495057', sw:3 }));
N.push(txt(RLX, RLY, '📋  COMPLETE REQUEST LIFECYCLE — Step by Step (src/core/master.ts)', { fontSize:18, color:'#1971c2', w:6180 }));
N.push(txt(RLX+20, RLY+50,
`STEP 1:  Client → HTTPS :8443  (TLS handshake, SNI, cipher negotiation)
STEP 2:  Master httpsServer "request" event fires → requestHandler(req, res)
STEP 3:  Rate Limiter: checkRateLimit(clientIP, pathRule)
           → fwMap / swMap / toMap  |  429 Too Many Requests if exceeded
STEP 4:  Cache lookup (if cache.enabled=true):
           key = buildKey(method, url) → "proxy:GET:/api/users"
           Redis GET key → HIT: res.end(cached)  |  MISS: continue
STEP 5:  Route matching: findPathRule(req.url, config.server.paths[])
           rule.sticky=true → NINJA_ROUTE cookie → forced upstream pick
STEP 6:  lb.pickFiltered(HEALTHY_UPSTREAMS, clientIP, attempted=[])
           → runs configured algorithm → UpstreamInstance
STEP 7:  Circuit Breaker: cbState.get(upstream.id)
           OPEN + within recovery → skip → retry next upstream → 503
           HALF_OPEN → allow 1 probe (test if recovered)
STEP 8:  dispatchToWorker(upstream, payload, clientIP, res)
           → worker.send({ type:"REQUEST", payload, requestId, clientIP })
           → replyHandlers.set(requestId, { res, upstream, startTime })
STEP 9:  Worker: http/https.request → collect chunks → decompress
           → process.send({ type:"RESPONSE", requestId, status, headers, body })
STEP 10: Master replyHandler: res.writeHead(status, headers) → res.end(body)
           → 502/503/504: retry with pickFiltered(attempted=[id]) up to maxAttempts
STEP 11: Cache write: Redis SET key body EX ttlSeconds  (if GET + 200 + enabled)
STEP 12: Metrics: ninja_http_requests_total++ | duration histogram | activeConns--

WS PATH:
STEP 1-2: "upgrade" event → handleWebSocketUpgrade(req, socket, head)
STEP 3:   lb.pick(HEALTHY, clientIP)  [No rate limit / cache for WS]
STEP 4:   net.connect / tls.connect to upstream
STEP 5:   Bidirectional pipe: socket ↔ target  [raw TCP frames, no IPC]

ERROR RESPONSES:
  429 Too Many Requests   — rate limit hit
  502 Bad Gateway         — upstream connection refused / bad response
  503 Service Unavailable — CB OPEN or no healthy upstreams
  504 Gateway Timeout     — worker request timeout exceeded`, { w:6160, h:980 }));

// ─── D: DATA STRUCTURES ──────────────────────────────────────────────────────
const DSX = 10615, DSY = 450;
N.push(rect(DSX-10, DSY-30, 6200, 840, { bg:'#f3f0ff', strokeColor:'#6741d9', sw:3 }));
N.push(txt(DSX, DSY, '🗂  KEY DATA STRUCTURES & TYPESCRIPT TYPES  (src/types/ + Zod schemas)', { fontSize:18, color:'#6741d9', w:6180 }));
N.push(txt(DSX+20, DSY+50,
`ConfigSchemaType (Zod inferred):                          UpstreamInstance (runtime):                  CircuitBreakerState:
──────────────────────────────────────────────────────    ──────────────────────────────────────────    ──────────────────────────────────
{                                                         {                                             Map<upstreamId, {
  server: {                                                 id: string                                    state: "CLOSED"|"OPEN"|"HALF_OPEN"
    listen:    number    // HTTP  :8080                     url: string                                   failures: number
    httpsPort: number    // HTTPS :8443                     weight: number                                openedAt: number | null
    workers:   number    // cluster.fork() count            effectiveWeight: number  ← CB adjusted        halfOpenAt: number | null
    timeout?:  number    // req timeout ms                  currentWeight:   number  ← SWRR state         lastFailure: number | null
    tls?: { cert, key, ca? }                               healthPath: string                          }>
  }                                                         tls?: { rejectUnauthorized, ca? }
  loadBalancing: {                                          metadata?: Record<string,string>
    strategy: LBStrategy                                  }
    failureThreshold: number  // CB threshold                                                          WorkerIPCMessage:
    recoveryTimeMs: number    // CB half-open delay     ServiceInstance:                               ─────────────────────────────────
    retry?: {                                             {                                             {
      maxAttempts: number                                   id: string                                    type: "REQUEST"|"RESPONSE"|"TIMEOUT"
      statusCodes: number[]   // [502,503,504]              url: string                                   requestId: string       (uuid)
    }                                                       status: "UP"|"DOWN"                           payload?:  ProxyPayload
  }                                                         registeredAt: Date                            status?:   number
  cache?: {                                                 lastHeartbeat: Date                           headers?:  Record<string,string>
    enabled: boolean                                        metadata?: Record<string,string>              body?:     string        (base64)
    host: string                                          }                                               error?:    string
    port: number                                                                                        }
    ttlSeconds: number                                  LBStrategy union type:
  }                                                     ────────────────────────────────────────────────
  upstreams: UpstreamConfig[]                           "round-robin" | "least-connections" | "ip-hash"
  paths?: PathRule[]                                    | "random" | "sticky" | "consistent-hash"
}                                                       | "least-bandwidth" | "resource-based" | "canary"`, { w:6160, h:760 }));

// ─── E: ADMIN ENDPOINTS & WS PROTOCOL ────────────────────────────────────────
const AEX = 10615, AEY = 1400;
N.push(rect(AEX-10, AEY-30, 6200, 610, { bg:'#e7f5ff', strokeColor:'#1971c2', sw:3 }));
N.push(txt(AEX, AEY, '🔌  ADMIN ENDPOINTS & WEBSOCKET PROTOCOL  (src/core/master.ts)', { fontSize:18, color:'#1971c2', w:6180 }));
N.push(txt(AEX+20, AEY+50,
`ADMIN ENDPOINTS:                                                            WEBSOCKET UPGRADE PROTOCOL:
──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────
GET  /__lb-stats                                                             "upgrade" event → handleWebSocketUpgrade(req, socket, head, config, lb)
  → { strategy, upstreams: [{id, url, status, effectiveWeight,
       currentWeight, activeConns, successCount, failureCount}] }            1. clientIP from x-forwarded-for or socket.remoteAddress
                                                                             2. lb.pick(HEALTHY_UPSTREAMS, clientIP)
GET  /metrics  → Prometheus text format                                      3. parse upstream URL → host, port
  # TYPE ninja_http_requests_total counter                                   4. isSecure = url.startsWith("https")
  # HELP ...                                                                 5. if isSecure: target = tls.connect({host,port,rejectUnauthorized,ca})
  ninja_http_requests_total{method="GET",path="/",status="200",...} 42          else:        target = net.connect({host, port})
                                                                             6. Send HTTP upgrade handshake to upstream:
GET  /__registry → { instances: ServiceInstance[] }                              "GET /path HTTP/1.1\r\nHost: upstream\r\n" +
                                                                                 "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
POST /__registry/register                                                        "Sec-WebSocket-Key: <key>\r\n\r\n"
  Body: { id, url, metadata? }                                               7. socket.pipe(target) ↔ target.pipe(socket)  [raw TCP]
  → 201 { message, instance }                                                8. Error/close: destroy both ends
  → 30s heartbeat timeout (dynamic only: metadata.dynamic="true")
                                                                             ⚠  WS bypasses: rate limiter, cache, retry, circuit breaker
DELETE /__registry/deregister/:id   → 200 { message }
POST  /__registry/heartbeat/:id     → 200 { message }                       Metrics still tracked:
GET   /__cache-stats → { hits, misses, hitRate, totalOps }                    ninja_active_connections{upstream_id} +1/-1`, { w:6160, h:540 }));

// ─── F: TLS / SECURITY ───────────────────────────────────────────────────────
const TLX = 10615, TLY = 2120;
N.push(rect(TLX-10, TLY-30, 6200, 530, { bg:'#fff0f6', strokeColor:'#c2255c', sw:3 }));
N.push(txt(TLX, TLY, '🔒  TLS / SECURITY LAYER  (src/core/master.ts + K8s Secret)', { fontSize:18, color:'#c2255c', w:6180 }));
N.push(txt(TLX+20, TLY+50,
`TLS TERMINATION (master.ts):                                          UPSTREAM TLS (worker.ts):
────────────────────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────
https.createServer({                                                  Per upstream config:
  key:  fs.readFileSync("key.pem")    // RSA private key               tls.rejectUnauthorized: true | false
  cert: fs.readFileSync("cert.pem")   // X.509 cert                    tls.ca: "/path/to/ca.pem" (custom CA)
}, requestHandler)                                                    httpsAgent = new https.Agent({ rejectUnauthorized, ca })

K8s TLS Secret "ninja-proxy-tls":                                     HEADERS INJECTED BY PROXY:
  cert.pem → base64 in Secret data.cert                                x-forwarded-for: clientIP
  key.pem  → base64 in Secret data.key                                 x-real-ip:       clientIP
  Mounted: /app/cert.pem, /app/key.pem                                 x-ninja-proxy:   "1.0"
  Volume:  secretName: ninja-proxy-tls                                 x-forwarded-proto: "https"
                                                                        host:            upstream hostname (rewritten)
TLS VERSION: TLS 1.2 + 1.3 (Node.js defaults)
CIPHER SUITES: Node.js OpenSSL defaults                               RATE LIMIT as DDoS defence:
SNI: Single cert (no multi-domain SAN by default)                       Fixed/Sliding/Token-Bucket per clientIP
OCSP Stapling: NOT configured (Phase 2)                                 → 429 before any proxy overhead
Mutual TLS (mTLS): NOT configured (Phase 2)                             → Per-path rules (config.server.paths[].rateLimit)`, { w:6160, h:460 }));

// ─── G: PHASE ROADMAP ────────────────────────────────────────────────────────
const PRX = 10615, PRY = 2760;
N.push(rect(PRX-10, PRY-30, 6200, 540, { bg:'#ebfbee', strokeColor:'#2f9e44', sw:3 }));
N.push(txt(PRX, PRY, '🗺  DEVELOPMENT PHASES & ROADMAP', { fontSize:18, color:'#2f9e44', w:6180 }));
N.push(txt(PRX+20, PRY+50,
`PHASE 1 — IMPLEMENTED ✅                                              PHASE 2 — PLANNED 🔜
──────────────────────────────────────────────────────────────────    ────────────────────────────────────────────────────────────────
✅ HTTP :8080 + HTTPS :8443 dual-server                               🔜 WebSocket LB via workers (currently Master event loop — scalability limit)
✅ Node.js cluster: master + N worker processes                       🔜 Distributed rate limiting via Redis (currently in-memory per worker)
✅ 8 LB strategies (SWRR, LeastConn, IPHash, Random,                 🔜 Persistent Service Registry (Consul / etcd — currently in-memory Map)
     ConsistentHash, LeastBandwidth, ResourceBased, Canary)          🔜 mTLS upstream auth (Phase 2 security)
✅ Circuit Breaker (CLOSED → OPEN → HALF_OPEN)                        🔜 OCSP Stapling + automatic cert rotation
✅ Rate Limiting (Fixed Window + Sliding Window + Token Bucket)       🔜 HTTP/2 → HTTP/1.1 bridge
✅ Redis Cache (TTL=60s, buildKey, invalidation, exponential backoff) 🔜 gRPC backend support
✅ Dynamic Service Registry (heartbeat 30s, metadata.dynamic)         🔜 WAF rules (OWASP Top 10)
✅ Health Checker (3s startup delay + 10s interval loop)              🔜 OpenTelemetry tracing (Jaeger / Zipkin)
✅ Prometheus metrics (/metrics) + Grafana dashboards                 🔜 kubectl apply in Jenkins (currently echo only)
✅ Docker Compose (reverse-proxy + redis + backends)                  🔜 Admin Web UI dashboard
✅ Kubernetes (namespace: reverse-proxy, ConfigMap, Secret, ClusterIP)🔜 Multi-region consistent hashing
✅ Jenkins CI/CD: GitHub → Build → SonarQube → Trivy → Test → Push   🔜 Header-based canary (x-canary header routing)
✅ Hot reload: fs.watch + SIGHUP → 100ms debounce → graceful restart  🔜 WebAssembly plugin system for custom LB algorithms
✅ Retry: maxAttempts=2, [502,503,504], pickFiltered()
✅ Sticky sessions: NINJA_ROUTE cookie
✅ Canary: 90/10 split, NINJA_CANARY cookie, x-canary header
✅ WebSocket TCP tunnel (master-owned bidirectional pipe)
✅ Admin endpoints: /__lb-stats, /metrics, /__registry, /__cache-stats
✅ Graceful shutdown: SIGTERM/SIGINT → close servers → process.exit(0)`, { w:6160, h:490 }));

// ─── save ─────────────────────────────────────────────────────────────────────
diagram.elements = [...existing, ...N];
writeFileSync(filePath, JSON.stringify(diagram, null, 2));
console.log(`Added ${N.length} new elements`);
console.log(`Total elements: ${diagram.elements.length}`);
console.log(`Saved to: ${filePath}`);
