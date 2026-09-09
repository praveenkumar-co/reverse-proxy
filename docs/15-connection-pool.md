# 🔌 HTTP/HTTPS Connection Pooling & Socket Reuse

## Overview
Establishing a new TCP connection on every incoming request introduces severe latency penalties (TCP 3-way handshake: SYN, SYN-ACK, ACK) and TLS negotiation overhead (ClientHello, ServerHello, Certificate exchange). At high throughput, closing sockets immediately leads to thousands of sockets stuck in `TIME_WAIT` state, eventually causing OS ephemeral port exhaustion (`EADDRNOTAVAIL`).

The Connection Pool maintains persistent, pre-warmed TCP connections to upstream services using persistent HTTP Keep-Alive agents.

```
Without Connection Pool:
Client ──► Proxy ───[TCP Handshake (1 RTT)]───► Upstream
                 ───[TLS Handshake (1-2 RTT)]──► Upstream
                 ───[HTTP Request/Response]───► Upstream
                 ───[TCP FIN / TIME_WAIT]─────► Upstream (Sockets exhausted!)

With Connection Pool:
Client ──► Proxy ───[Reused Keep-Alive Socket]──► Upstream (0ms handshake latency)
```

---

## 1. Pool Architecture (`src/core/proxy/connection.pool.ts`)

Ninja Reverse Proxy initializes two global, pre-configured agent singletons:

```typescript
import http from 'http';
import https from 'https';

export const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 60000,
});

export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 60000,
  rejectUnauthorized: true,
});

export function getAgent(isHttps: boolean): http.Agent | https.Agent {
  return isHttps ? httpsAgent : httpAgent;
}
```

---

## 2. Parameter Tuning Matrix

| Parameter | Default | Production Impact |
|---|---|---|
| `keepAlive: true` | `true` | Keeps TCP sockets open across requests. Eliminates 1–3 RTT latency on every request. |
| `maxSockets: 256` | `256` | Maximum concurrent active sockets allocated per upstream origin `(host:port)`. |
| `maxFreeSockets: 64` | `64` | Maximum idle sockets kept open in the pool awaiting incoming traffic. Excess closed gracefully. |
| `keepAliveMsecs: 1000`| `1000`| Interval for sending TCP keep-alive probes to detect dead upstream nodes. |
| `timeout: 60000` | `60000`| Idle timeout (60s) before an unused socket is closed to conserve file descriptors. |

---

## 3. Worker-Level Concurrency

Because Ninja Reverse Proxy runs multiple worker processes via the Node.js cluster module, each worker process instantiates its own isolated connection pool:

$$\text{Total Max Concurrent Upstream Sockets} = \text{Workers} \times \text{maxSockets}$$

For a 4-worker configuration with `maxSockets: 256`, the proxy cluster can drive up to **1,024 concurrent keep-alive connections** per backend without socket thrashing.

---

## 4. Operational Edge Cases & Gotchas

1. **Half-Closed Sockets**: Upstream servers typically have their own `keepAliveTimeout` (e.g., NGINX defaults to 65s, Node.js HTTP server defaults to 5s). If the upstream closes a connection while a request is in-flight, the proxy catches the `ECONNRESET` event and dispatches a retry via `RetryHandler`.
2. **Socket Leaks on Stream Abort**: If a client disconnects mid-download, the upstream socket must be explicitly destroyed or drained (`res.resume()`), otherwise it remains tied to the active socket count and starves the pool.
