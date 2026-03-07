#  Ninja Reverse Proxy

A production-grade Reverse Proxy built from scratch using TypeScript and Node.js.

##  Features

- **Cluster Architecture** — Master/Worker pattern using Node.js cluster module
- **Round Robin Load Balancing** — Equal distribution of requests across workers
- **Health Checks** — Initial + continuous health monitoring of backend servers
- **Rate Limiting** — Per-route request limiting with sliding window algorithm
- **HTTPS Support** — SSL Termination at proxy level
- **Request Timeout** — Auto timeout after 5 seconds
- **Auto Worker Replacement** — Dead workers automatically replaced
- **All HTTP Methods** — GET, POST, PUT, PATCH, DELETE support
- **YAML Configuration** — Simple config file with Zod validation

##  Project Structure
```
src/
├── index.ts          → Entry point, CLI
├── server.ts         → Main proxy logic
├── config.ts         → YAML parser
├── config-schema.ts  → Zod validation
├── server-schema.ts  → Worker message schema
├── health.ts         → Health check functions
└── rate-limiter.ts   → Rate limiting class
```

##  Configuration
```yaml
server:
  listen: 8080
  workers: 4

  upstreams:
    - id: node1
      url: http://localhost:8001
    - id: node2
      url: http://localhost:8002

  paths:
    - path: /
      upstream:
        - node1
        - node2
      rateLimit:
        windowMs: 60000
        maxRequests: 100

    - path: /admin
      upstream:
        - node2
      rateLimit:
        windowMs: 60000
        maxRequests: 10
```

## Installation
```bash
# Clone karo
git clone https://github.com/username/ninja-reverse-proxy.git

# Dependencies install karo
pnpm install

# SSL Certificate banao (development)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
```

##  Running
```bash
# Terminal 1 — Backend 1
node server1.js

# Terminal 2 — Backend 2
node server2.js

# Terminal 3 — Reverse Proxy
pnpm dev
```

##  Testing
```bash
# GET request
curl http://localhost:8080/

# POST request
curl -X POST https://localhost:8443/ \
  -H "Content-Type: application/json" \
  -d '{"name": "Praveen"}'

# HTTPS
https://localhost:8443/
https://localhost:8443/admin
```

##  Architecture
```
CLIENT
  ↓ HTTP
httpServer (8080) → 301 Redirect → HTTPS
  ↓ HTTPS
httpsServer (8443) → SSL Terminate
  ↓ IPC
WORKER → Rule check → Healthy upstream
  ↓ HTTP
BACKEND (node1/node2)
  ↓ HTTP Response
WORKER → Master → CLIENT
```

##  How It Works

1. **Client** sends request to proxy
2. **HTTP Server** redirects to HTTPS
3. **HTTPS Server** terminates SSL, checks rate limit
4. **Master** picks worker using Round Robin
5. **Worker** finds matching route rule
6. **Worker** checks healthy upstreams
7. **Worker** forwards to backend via HTTP
8. **Backend** responds
9. **Worker** sends reply to Master
10. **Master** sends response to Client

## Security Features

| Feature | Details |
|---|---|
| HTTPS | SSL Termination at proxy |
| Rate Limiting | Per-route sliding window |
| Health Checks | Every 10 seconds |
| X-Forwarded-For | Real IP forwarding |
| Request Timeout | 5 second timeout |

## Tech Stack

- **TypeScript** — Type safety
- **Node.js Cluster** — Multi-process architecture
- **Zod** — Schema validation
- **YAML** — Configuration
- **Commander** — CLI

##  Contributing

Pull requests are welcome!

## License

MIT