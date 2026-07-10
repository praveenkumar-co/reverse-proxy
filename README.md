# Ninja Reverse Proxy

A production-grade, backend-agnostic **Layer 7 Reverse Proxy** built from scratch in TypeScript and Node.js.

Designed in the same philosophy as Nginx, Traefik, and HAProxy — configure it once, point it at any backend, and it handles everything else.

---

## Works with any HTTP backend

node· Kubernetes Services · Docker Compose services · **Any service that speaks HTTP**

The proxy never cares what technology runs behind the URLs. You configure upstreams in `config.yaml` and the proxy routes, balances, caches, rate-limits, and health-checks them automatically.

---

## Features

| Feature | Details |
|---|---|
| Cluster Architecture | Master/Worker pattern via Node.js cluster — uses all CPU cores |
| Round-Robin Load Balancing | Equal request distribution across healthy upstreams |
| Circuit Breaker | Marks upstreams DOWN after configurable failure threshold |
| Redis Response Cache | GET response caching with configurable TTL |
| Per-Route Rate Limiting | Sliding window rate limiter per client IP per route |
| Service Registry | Backends self-register, deregister, and send heartbeats |
| Continuous Health Checks | Every 10 seconds — auto-removes and auto-recovers upstreams |
| HTTPS / TLS Termination | Full SSL at the proxy; all HTTP auto-redirected (301) |
| Sticky Sessions | Cookie-based session affinity per upstream |
| Retry Logic | Up to 2 retries on upstream failure, each on a different upstream |
| Graceful Shutdown | Drains all connections on SIGTERM / SIGINT |
| Hot Reload | Watches `config.yaml` and `config.d/` — zero-downtime config updates |
| Admin API | Live stats for load balancer, cache, registry, auto scaler |
| YAML Configuration | One file, fully validated with Zod — no source code changes needed |

---

## Quick Start

### 1. Install globally

```bash
npm install -g ninja-reverse-proxy
```

### 2. Generate TLS certificates

```bash
openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem -out cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

### 3. Create your config file

```yaml
# config.yaml
server:
  listen: 8080
  httpsPort: 8443
  workers: 2

  loadBalancing:
    strategy: round-robin
    failureThreshold: 3
    recoveryTimeMs: 15000
    retry:
      maxAttempts: 2
      statusCodes: [502, 503, 504]

  upstreams:
    - id: my-api
      url: http://localhost:5000
    - id: my-api-2
      url: http://localhost:5001

  paths:
    - path: /
      upstream: [my-api, my-api-2]

  headers:
    - key: X-Forwarded-For
      value: client_ip

  cache:
    enabled: false
    host: redis
    port: 6379
    ttlSeconds: 60
```

### 4. Start the proxy

```bash
ninja-proxy --config config.yaml
```

### 5. Test it

```bash
curl -k https://localhost:8443/
curl -k https://localhost:8443/__lb-stats
```

---

## Dynamic Service Registry

Backends can self-register at runtime without touching `config.yaml`:

```bash
# Register a new upstream dynamically
curl -X POST -H "Content-Type: application/json" \
  -d '{"id":"my-service","url":"http://localhost:3000"}' \
  http://localhost:8080/__registry/register

# Send a heartbeat
curl -X PUT http://localhost:8080/__registry/heartbeat/my-service

# Deregister
curl -X DELETE http://localhost:8080/__registry/deregister/my-service
```

---

## Multi-Tenant Config (Nginx-style)

Drop extra config files into a `config.d/` folder — the proxy merges them automatically with zero downtime:

```bash
mkdir config.d

# Each tenant/app gets their own isolated file
echo "
server:
  upstreams:
    - id: tenant-a
      url: http://localhost:4000
  paths:
    - path: /tenant-a
      upstream: [tenant-a]
" > config.d/tenant-a.yaml
```

The proxy hot-reloads `config.d/` automatically whenever a file is added or changed.

---

## Admin API

| Endpoint | Method | Description |
|---|---|---|
| `/__lb-stats` | GET | Load balancer stats + healthy upstreams |
| `/__cache-stats` | GET | Redis cache hit/miss stats |
| `/__registry` | GET | All registered services |
| `/__registry/register` | POST | Register a new upstream |
| `/__registry/deregister/:id` | DELETE | Deregister an upstream |
| `/__registry/heartbeat/:id` | PUT | Upstream heartbeat ping |

---

## Configuration Reference

| Field | Default | Description |
|---|---|---|
| `server.listen` | `8080` | HTTP port — redirects all traffic to HTTPS |
| `server.httpsPort` | `8443` | HTTPS port — main entry point |
| `server.workers` | `2` | Set to your CPU core count |
| `loadBalancing.strategy` | `round-robin` | `round-robin` \| `least-connections` \| `ip-hash` \| `random` |
| `loadBalancing.failure0Threshold` | `3` | Mark upstream DOWN after N consecutive failures |
| `loadBalancing.recoveryTimeMs` | `15000` | Retry a DOWN upstream after N ms |
| `cache.enabled` | `false` | Enable Redis GET response caching |
| `cache.ttlSeconds` | `60` | Cache TTL in seconds |

---

## Repository

[github.com/praveenkumar-co/reverse-proxy](https://github.com/praveenkumar-co/reverse-proxy)

---

## License

MIT