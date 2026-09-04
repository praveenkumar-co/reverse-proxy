# 🏛️ Master-Worker Cluster Architecture — How It Works

## What Is It?

Node.js is single-threaded — one process uses only 1 CPU core. On a machine with 8 cores, 7 cores sit idle.

Master-Worker cluster uses Node.js `cluster` module to spawn multiple worker processes — one per CPU core. All workers share the same port. OS distributes incoming connections across workers.

---

## Process Layout

```
           ┌─────────────────────┐
           │    MASTER PROCESS   │
           │  - Starts workers   │
           │  - Manages TLS      │
           │  - Health checks    │
           │  - Load balancer    │
           │  - Registry         │
           │  - WebSocket (TLS)  │
           └────────┬────────────┘
                    │ cluster.fork()
           ┌────────┴────────────┐
           │                     │
    ┌──────▼──────┐       ┌──────▼──────┐
    │  WORKER 1   │       │  WORKER 2   │
    │ - HTTP pipe │       │ - HTTP pipe │
    │ - Middleware│       │ - Middleware│
    │ - L1 cache  │       │ - L1 cache  │
    └─────────────┘       └─────────────┘
```

---

## Master Responsibilities

```typescript
// master.ts
if (cluster.isPrimary) {
    // 1. Load config
    // 2. Load TLS certificates
    // 3. Initialize load balancer
    // 4. Initialize service registry
    // 5. Start health checks
    // 6. Fork workers
    for (let i = 0; i < workerCount; i++) {
        const worker = cluster.fork({ APP_CONFIG: JSON.stringify(config) });
        WORKER_POOL.push(worker);
    }
    // 7. Create httpServer (port 8080)
    // 8. Create httpsServer (port 8443) if TLS configured
    // 9. Handle WebSocket upgrades (TLSSocket path)
    // 10. Restart crashed workers
}
```

---

## Worker Responsibilities

```typescript
// worker.ts
if (cluster.isWorker) {
    const config = JSON.parse(process.env.APP_CONFIG);
    // 1. Build middleware pipeline
    // 2. Listen for HTTP requests from master (via IPC)
    // 3. Listen for plain WebSocket upgrades from master (via IPC)
    // 4. Run middleware chain: CORS → Auth → RateLimit → Cache → CircuitBreaker → Proxy
    // 5. Forward to backend via http.request()
    // 6. Return response to client
}
```

---

## IPC — Inter Process Communication

Master and workers communicate via Node.js IPC channel (Unix domain socket under the hood):

```typescript
// Master sends plain socket + request metadata to worker
worker.send(JSON.stringify({
    type: "HTTP_REQUEST",
    reqFields: { method, url, headers },
    upstreamUrl: "http://127.0.0.1:3009",
}), socket);  // ← passes OS file descriptor

// Worker receives it
process.on("message", (msg, socket) => {
    const data = JSON.parse(msg);
    if (data.type === "HTTP_REQUEST") {
        handleRequest(data, socket);
    }
});
```

**What gets passed via IPC:**
- JSON metadata (request fields, upstream URL)
- OS file descriptor of the client socket

**What CANNOT be passed via IPC:**
- `tls.TLSSocket` — JS object with crypto state in memory

---

## Worker Auto-Restart

```typescript
// master.ts
cluster.on("exit", (worker) => {
    logger.warn("Master", `Worker ${worker.process.pid} died, restarting...`);
    const newWorker = cluster.fork({ APP_CONFIG: JSON.stringify(config) });
    setupWorkerMessageHandling(newWorker);
    WORKER_POOL.push(newWorker);
});
```

If a worker crashes (unhandled exception, OOM, etc.), master immediately forks a replacement. Zero downtime.

---

## Middleware Pipeline in Worker

Every HTTP request goes through this chain:

```
Request
   ↓
1. CORS middleware      — Add CORS headers
   ↓
2. Auth middleware      — Verify JWT / API key
   ↓
3. Rate Limit          — Check request count
   ↓
4. Cache middleware     — Check L1/L2 cache
   ↓
5. Circuit Breaker      — Check if upstream healthy
   ↓
6. Bulkhead            — Check concurrency slots
   ↓
7. Proxy               — Forward to backend, get response
   ↓
8. Response            — Write to client socket
```

Each middleware calls `next()` to pass to the next one — same as Express/Koa onion model.

---
