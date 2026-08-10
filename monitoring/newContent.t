A WebSocket connection always starts as a standard HTTP/1.1 GET request sent by the client. This initial request must contain specific Upgrade: websocket and Connection: Upgrade headers. Your reverse proxy must explicitly read these headers, pass them to the backend server, and handle the 101 Switching Protocols response to turn the TCP connection into an open WebSocket tunnel. Without this specific upgrade handshake from the client, the proxy treats it as a normal HTTP request over TCP

Architectural Drawbacks :

Stateful Connection Bloat: Proxies must maintain an active TCP socket for every single connected user. This consumes high memory and limits the total number of concurrent users a single proxy instance can handle

WebSockets bypass reverse proxy caching layers (like Nginx, Cloudflare, or Varnish). Every single byte of data must travel all the way to the origin backend server, increasing server load.

Requests/sec
     ↓
Master
     ↓
┌─────────┬─────────┬─────────┐
│ Worker1 │ Worker2 │ Worker3 │
│ Agent   │ Agent   │ Agent   │
└────┬────┴────┬────┴────┬────┘
     │          │          │
     ▼          ▼          ▼
   TCP pool   TCP pool   TCP pool
     │          │          │
     └──────────┼──────────┘
                ▼
             Backend

