# 🔌 WebSocket Proxying — How It Works

## What Is a WebSocket Connection?

WebSocket is a **persistent, bidirectional TCP connection** that starts as an HTTP request and then upgrades to a different protocol. Once upgraded, both sides can send messages at any time — unlike HTTP where only the client can initiate.

---

## Phase 1 — HTTP Upgrade Handshake

Browser sends:
```
GET /socket.io/?EIO=4&transport=websocket HTTP/1.1
Host: localhost:8443
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
```

This tells the server: "Switch this TCP connection from HTTP to WebSocket."

---

## Phase 2 — `upgrade` Event in Node.js

Node.js does NOT call the normal request handler. Instead it fires:

```typescript
// master.ts
httpsServer.on("upgrade", wsUpgradeHandler);
```

Handler receives:
- `req` — original HTTP Upgrade request
- `socket` — raw TCP socket to browser (**TLSSocket** when over HTTPS)
- `head` — extra buffered bytes

---

## Phase 3 — Load Balancer Picks Upstream

```typescript
const upstreamId = lb.pickFiltered(HEALTHY_UPSTREAMS, clientIP, new Set(), cookies);
const serviceInstance = registry.get(upstreamId);
// serviceInstance.url = "http://127.0.0.1:3009"
```

---

## Phase 4 — TLSSocket vs Plain Socket

```typescript
if (socket instanceof tls.TLSSocket) {
    // HTTPS WebSocket — handle directly in master (no IPC)
    tunnelWebSocket(socket, serviceInstance.url, reqFields, head, tlsConfig, onClose);
    return;
}
// Plain HTTP WebSocket — send to worker via IPC
worker.send(JSON.stringify(payload), socket);
```

| Connection | Socket Type | IPC possible? | Handler |
|---|---|---|---|
| `wss://` (HTTPS) | `tls.TLSSocket` | NO | Master directly |
| `ws://` (HTTP) | `net.Socket` | YES | Worker via IPC |

**Why can't TLSSocket go via IPC?**  
IPC passes OS file descriptors. A `TLSSocket` is a JS object with in-memory crypto state that cannot be transferred across process boundaries.

---

## Phase 5 — `tunnelWebSocket()` — The Core

```typescript
// websocket.handler.ts
const targetSocket = net.connect({ host: "127.0.0.1", port: 3009 }, () => {
    // Forward the original HTTP Upgrade request to backend
    targetSocket.write(rawHttpUpgradeRequest);

    // Bidirectional pipe — THE ENTIRE PROXY LOGIC
    clientSocket.pipe(targetSocket);  // Browser → Backend
    targetSocket.pipe(clientSocket);  // Backend → Browser
});
```

`.pipe()` means: every byte arriving on source → immediately written to destination. The proxy never parses WebSocket frames — it is a **blind TCP byte tunnel**.

---

## Phase 6 — Backend responds 101

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Sec-WebSocket-Accept: 2SZer1O29Hdde2wNE8uh8dYfdFg=
```

Travels back through pipe → browser sees 101 in Network tab → WebSocket handshake complete.

---

## Phase 7 — Live Bidirectional Tunnel

```
Browser           Master Process          Chess Backend
  |                    |                       |
  |── move e2e4 ──────►|── raw bytes ─────────►|
  |                    |                       |
  |◄─ boardState ──────|◄── raw bytes ──────────|
```

Proxy does not read or understand these messages — pure byte forwarding.

---

## Phase 8 — Cleanup

```typescript
targetSocket.on("close", triggerClose);
clientSocket.on("close", triggerClose);

const triggerClose = () => {
    lb.releaseConnection(upstreamId);
    metricsRegistry.recordActiveConnection(id, -1);
};
```

---
