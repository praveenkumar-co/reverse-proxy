# 🌐 Regular HTTPS Request Flow — How It Works

## What Happens for a Normal Page Request?

When browser requests `https://localhost:8443/index` (not WebSocket), here is the complete flow:

---

## Step-by-Step Flow

```
Browser
  │
  │ 1. TCP connect to localhost:8443
  │ 2. TLS handshake (cert.pem exchanged)
  │ 3. HTTP GET /index HTTP/1.1
  ▼
Master Process (httpsServer)
  │
  │ 4. httpsServer "request" event fires
  │ 5. Extract clientIP from headers / socket
  │ 6. Check if internal path (/__registry, /metrics, /__lb-stats)
  │    └─ if yes → handle directly, return
  │
  │ 7. Pick a worker from WORKER_POOL (random)
  │ 8. Send request via IPC:
  │    worker.send({ type: "HTTP_REQUEST", reqFields, upstreamUrl }, socket)
  │    (passes plain net.Socket file descriptor)
  ▼
Worker Process
  │
  │ 9.  Receive IPC message + socket
  │ 10. Reconstruct IncomingMessage from reqFields
  │ 11. Run middleware pipeline:
  │     CORS → Auth → RateLimit → Cache → CircuitBreaker → Bulkhead → Proxy
  │
  │ 12. Proxy middleware:
  │     const upstreamReq = http.request(upstreamUrl + path, options);
  │     req.pipe(upstreamReq);        // forward request body
  │     upstreamReq.pipe(clientSocket); // stream response back
  ▼
Chess Backend (127.0.0.1:3009)
  │
  │ 13. Processes request
  │ 14. Returns HTTP response (HTML, JSON, etc.)
  ▼
Back through pipe → Browser renders page
```

---

## Why Master Picks a Worker Randomly

```typescript
// master.ts
const workerIndex = Math.floor(Math.random() * WORKER_POOL.length);
const worker = WORKER_POOL[workerIndex];
worker.send(JSON.stringify(payload), socket);
```

OS already distributes connections across workers at TCP level. But for fine-grained control (e.g. sticky sessions, consistent hashing), master picks the worker. Random here is a simple default — can be changed to round-robin per worker.

---

## HTTP vs HTTPS — Socket Difference

```typescript
// HTTP request (port 8080) → plain net.Socket
httpServer.on("request", (req, res) => {
    // req.socket is net.Socket
    // Can be sent to worker via IPC
});

// HTTPS request (port 8443) → TLSSocket
httpsServer.on("request", (req, res) => {
    // req.socket is tls.TLSSocket
    // CANNOT be sent to worker via IPC
    // BUT: req itself is already decrypted by Node.js TLS layer
    // So master reads the decrypted request and sends only the
    // JSON metadata to worker — NOT the socket itself
});
```

Key insight: For HTTPS requests, master reads the decrypted HTTP request, serializes it to JSON (`reqFields`), and sends only the JSON to the worker. The worker then uses `res` (which is still the TLS-encrypted response stream) to write back.

---

## HTTP → HTTPS Redirect

```typescript
// httpServer (port 8080)
httpServer.on("request", (req, res) => {
    if (httpsServer) {
        // Redirect to HTTPS
        res.writeHead(301, {
            Location: `https://${req.headers.host?.split(':')[0]}:8443${req.url}`
        });
        res.end();
        return;
    }
    // No TLS configured — handle HTTP directly
    dispatchToWorker(req, res);
});
```

Anyone hitting `http://localhost:8080/index` gets:
```
HTTP/1.1 301 Moved Permanently
Location: https://localhost:8443/index
```

---

## Response Streaming

Proxy doesn't buffer the entire response — it streams:

```typescript
// proxy middleware
const upstreamReq = http.request(options, (upstreamRes) => {
    // Forward status + headers immediately
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

    // Stream body as chunks arrive — no buffering
    upstreamRes.pipe(res);
});

// Forward request body too (for POST/PUT)
req.pipe(upstreamReq);
```

This means first byte of response reaches browser before backend finishes sending — critical for large responses like file downloads or Server-Sent Events.

---
