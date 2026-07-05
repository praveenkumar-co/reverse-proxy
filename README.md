# Ninja Reverse Proxy

A production-grade, backend-agnostic **Layer 7 Reverse Proxy** built from scratch in **TypeScript** and **Node.js**.

Designed in the same philosophy as **Nginx**, **Traefik**, and **HAProxy** — configure it once, point it at any backend, and it handles everything else.

```
Developer → GitHub → Jenkins CI/CD → Docker → Any Backend
```

---

## What it is

Ninja Reverse Proxy is a fully configurable, self-contained reverse proxy that works with **any HTTP backend**:

- Express · Fastify · NestJS
- Django · FastAPI · Flask
- Spring Boot · Quarkus
- Go (net/http, Gin, Echo)
- ASP.NET Core
- Kubernetes Services
- Docker Compose services
- Any service that speaks HTTP

The proxy never cares what technology runs behind the URLs. You configure upstreams in `config.yaml` and the proxy routes, balances, caches, rate-limits, and health-checks them automatically.

---

## Features

| Feature | Details |
|---|---|
| **Cluster Architecture** | Master/Worker pattern via Node.js `cluster` — uses all CPU cores |
| **Round-Robin Load Balancing** | Equal request distribution across healthy upstreams |
| **Circuit Breaker** | Marks upstreams DOWN after configurable failure threshold |
| **Redis Response Cache** | GET response caching with configurable TTL; auto-invalidated on writes |
| **Per-Route Rate Limiting** | Sliding window rate limiter per client IP per route |
| **Service Registry** | Backends self-register, deregister, and send heartbeats |
| **Continuous Health Checks** | Every 10 seconds — auto-removes and auto-recovers upstreams |
| **HTTPS / TLS Termination** | Full SSL at the proxy; all HTTP auto-redirected (301) |
| **Auto Scaling** | Optionally spawns/kills upstream servers dynamically based on load |
| **Retry Logic** | Up to 2 retries on upstream failure, each on a different worker |
| **Graceful Shutdown** | Drains all connections on SIGTERM / SIGINT |
| **Admin API** | Live stats for load balancer, cache, registry, auto scaler |
| **YAML Configuration** | One file, fully validated with Zod — no source code changes needed |
| **Docker + Kubernetes** | Ships with Compose and K8s manifests out of the box |
| **Jenkins CI/CD** | Declarative pipeline included |
| **SonarQube** | `sonar-project.properties` included for static analysis |

---

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │               Ninja Reverse Proxy                │
                    │                                                   │
  Client ──HTTPS──► │  Master Process                                   │
                    │    ├── Rate Limiter (per-IP, per-route)           │
                    │    ├── Redis Cache (GET responses)                │
                    │    ├── Load Balancer (round-robin / ip-hash / …)  │
                    │    ├── Health Checker (every 10s)                 │
                    │    ├── Service Registry                           │
                    │    └── Auto Scaler (optional)                     │
                    │                                                   │
                    │  Worker Processes (one per CPU core)              │
                    │    └── Forward requests via keepAlive TCP         │
                    └───────────┬─────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
           backend-a       backend-b       backend-c
         (Express)       (Django)        (Spring Boot)
```

### CI/CD Flow

```
Developer
  │ edits code / config
  ▼
GitHub
  ▼
Jenkins (Jenkinsfile)
  ├── Setup (npm ci)
  ├── Static Analysis — Lint + npm audit (parallel)
  ├── Unit Tests
  ├── Build Artifact (tsc)
  └── Deploy to Production (main branch, prod env)
```

---

## Quick Start

### 1. Clone and generate TLS certificates

```bash
git clone https://github.com/praveenkumar-co/reverse-proxy.git
cd reverse-proxy

# Generate a self-signed certificate (for development)
openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem -out cert.pem \
  -days 365 -nodes
```

### 2. Configure your backends

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` — replace the example upstreams with your real backend URLs:

```yaml
upstreams:
  - id: my-api
    url: http://my-api:8000

  - id: my-frontend
    url: http://my-frontend:3000
```

### 3. Run

```bash
# Proxy + Redis only (you bring your own backends)
docker-compose up --build

# Or run the built-in demo (backend-a + backend-b included)
cd examples/docker-compose && docker-compose up --build
```

### 4. Test

```bash
curl -k https://localhost:8443/
curl -k https://localhost:8443/__lb-stats
curl -k https://localhost:8443/__registry
```

---

## Configuration Reference

`config.example.yaml` is the fully commented template. Copy it to `config.yaml` to get started.

```yaml
server:

  listen: 8080          # HTTP port — redirects all traffic to HTTPS
  httpsPort: 8443       # HTTPS port — main entry point
  workers: 2            # Set to your CPU core count (run: nproc)

  loadBalancing:
    strategy: round-robin           # round-robin | least-connections | ip-hash | random
    failureThreshold: 3             # Mark upstream DOWN after 3 consecutive failures
    recoveryTimeMs: 15000           # Retry a DOWN upstream after 15 seconds

  autoScaling:
    enabled: false                  # false → static backends (like Nginx)
                                    # true  → dynamic server spawning based on load
    minServers: 2
    maxServers: 10
    scaleUpAt: 10                   # Spawn a server when connections exceed this
    scaleDownAt: 2                  # Kill a server when connections drop below this
    cooldownMs: 60000
    startPort: 9000
    proxyPort: 8080

  cache:
    enabled: false                  # true → cache GET responses in Redis
    host: redis
    port: 6379
    ttlSeconds: 60

  upstreams:
    - id: backend-a                 # Any name — used to reference in paths
      url: http://backend-a:3001    # Any HTTP URL — any technology

    - id: backend-b
      url: http://backend-b:3002

  paths:
    - path: /                       # Route all traffic to both backends
      upstream:
        - backend-a
        - backend-b
      rateLimit:
        windowMs: 60000             # 1-minute window
        maxRequests: 100000         # per client IP

    - path: /api                    # Route /api to a specific backend only
      upstream:
        - backend-a

  headers:
    - key: X-Forwarded-For
      value: client_ip
    - key: X-Real-IP
      value: client_ip
```

---

## Docker

### Build the proxy image

```bash
docker build -t ninja-reverse-proxy:latest .
```

### Run with Docker Compose (proxy + Redis only)

```bash
# Uses docker-compose.yml in project root
docker-compose up --build
```

Your own backend services connect to the `proxy-network` and are listed in `config.yaml`.

### Run the full built-in demo

```bash
# Spins up proxy + redis + backend-a + backend-b
cd examples/docker-compose
docker-compose up --build
```

### Connect your real app

Add your app as a service in your own `docker-compose.yml` and connect it to the proxy network:

```yaml
services:

  my-express-app:
    image: my-express-app:latest
    networks:
      - proxy-network

networks:
  proxy-network:
    external: true
    name: reverse-proxy_proxy-network
```

Then add it to `config.yaml`:

```yaml
upstreams:
  - id: my-express-app
    url: http://my-express-app:3000
```

---

## Kubernetes

See [`k8s/README.md`](k8s/README.md) for the full deployment guide.

Quick overview:

```bash
# Apply all manifests
kubectl apply -f k8s/

# Port-forward for local testing
kubectl port-forward svc/ninja-reverse-proxy-svc 8080:8080 8443:8443

# Verify
curl -k https://localhost:8443/__lb-stats
```

The proxy config is mounted as a Kubernetes ConfigMap — change it without rebuilding the image.

---

## Auto Scaler

The Auto Scaler is **fully optional** and controlled entirely by `config.yaml`.

### Static mode (default — works like Nginx)

```yaml
autoScaling:
  enabled: false
```

The proxy uses only the upstream servers listed in `config.yaml`. This is appropriate for production setups where you manage your own backend services.

### Dynamic mode

```yaml
autoScaling:
  enabled: true
  minServers: 2
  maxServers: 10
  scaleUpAt: 10       # spawn a new server when total active connections exceed this
  scaleDownAt: 2      # kill the oldest server when connections drop below this
  cooldownMs: 60000   # minimum wait between scale events
```

When enabled, the proxy dynamically spawns (`server-template.js`) and kills backend servers based on active connection count. See `examples/docker-compose/` for a working demonstration.

---

## Admin API

All admin endpoints are available on the HTTPS port.

| Endpoint | Method | Description |
|---|---|---|
| `/__lb-stats` | GET | Load balancer stats + healthy upstreams |
| `/__cache-stats` | GET | Redis cache hit/miss stats |
| `/__registry` | GET | All registered services |
| `/__autoscaler-stats` | GET | Auto scaler status |
| `/__registry/register` | POST | Register a new upstream |
| `/__registry/deregister/:id` | DELETE | Deregister an upstream |
| `/__registry/heartbeat/:id` | PUT | Upstream heartbeat ping |

```bash
curl -k https://localhost:8443/__lb-stats
curl -k https://localhost:8443/__cache-stats
curl -k https://localhost:8443/__registry
curl -k https://localhost:8443/__autoscaler-stats
```

---

## Jenkins CI/CD Pipeline

A declarative `Jenkinsfile` is included in the project root.

**Pipeline stages:**

1. **Setup** — `npm ci` (deterministic install)
2. **Static Analysis** — Lint + `npm audit` (parallel)
3. **Unit Tests** — conditional on `RUN_TESTS` parameter
4. **Build Artifact** — `npm run build` (TypeScript → JavaScript)
5. **Deploy to Production** — branch `main` + `ENV_TYPE=prod` + manual approval gate

**Global options:** 1-hour timeout · last 10 builds retained · no concurrent builds · timestamps on every log line.

---

## SonarQube

`sonar-project.properties` is included. To run a scan:

```bash
sonar-scanner \
  -Dsonar.host.url=http://localhost:9000 \
  -Dsonar.login=YOUR_SONAR_TOKEN
```

Scans the `src/` directory. Excludes `node_modules/`, `dist/`, certificates, and CI files.

---

## Security Scanning (Trivy)

```bash
# Scan dependencies
trivy fs .

# Scan the Docker image
docker build -t ninja-reverse-proxy:latest .
trivy image ninja-reverse-proxy:latest
```

---

## Project Structure

```
ninja-reverse-proxy/
├── src/                           ← Proxy source (TypeScript)
│   ├── index.ts                   → CLI entry point
│   ├── server.ts                  → Master + Worker proxy engine
│   ├── loadBalancer.ts            → Round-robin with circuit breaker
│   ├── auto-scaler.ts             → Dynamic server scaling
│   ├── health.ts                  → Health checker (initial + continuous)
│   ├── Serviceregistry.ts         → Service registry (register/heartbeat/deregister)
│   ├── cache.ts                   → Redis cache (get/set/invalidate/stats)
│   ├── rate-limiter.ts            → Sliding window rate limiter
│   ├── config-schema.ts           → Zod config validation schema
│   ├── config.ts                  → YAML parser
│   └── server-schema.ts           → Worker IPC message schema
│
├── k8s/                           ← Kubernetes manifests
│   ├── configmap.yaml
│   ├── tls-secret.yaml
│   ├── proxy-deployment.yaml
│   ├── proxy-service.yaml
│   └── README.md
│
├── examples/                      ← Integration examples (NOT part of the proxy)
│   ├── docker-compose/            ← Full demo stack (backend-a + backend-b)
│   │   ├── server-template.js     → Minimal demo backend
│   │   ├── Dockerfile.server      → Demo backend image
│   │   ├── docker-compose.yml     → Full demo stack
│   │   ├── config.yaml            → Demo config
│   │   └── README.md
│   └── express/                   ← Express.js integration example
│       ├── server.js
│       └── README.md
│
├── Dockerfile                     ← Proxy image (multi-stage build)
├── Jenkinsfile                    ← CI/CD declarative pipeline
├── sonar-project.properties       ← SonarQube config
├── docker-compose.yml             ← Proxy + Redis only
├── config.example.yaml            ← Fully commented configuration template
├── .dockerignore
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Tech Stack

| Technology | Purpose |
|---|---|
| TypeScript | Full type safety |
| Node.js Cluster | Master/Worker multi-process architecture |
| Redis | Response caching |
| Zod | Schema validation for config and worker messages |
| YAML | Human-readable configuration |
| Commander | CLI entry point |
| Docker Compose | Orchestration |
| Kubernetes | Production cluster deployment |
| Jenkins | CI/CD pipeline |
| SonarQube | Static code analysis |
| Trivy | Container security scanning |

---

## Request Lifecycle

```
Client → :8080 HTTP → 301 redirect to HTTPS
Client → :8443 HTTPS
  1. Rate limiter checks client IP — 429 if exceeded
  2. GET requests → Redis cache checked — HIT returns instantly
  3. Write requests (POST/PUT/PATCH/DELETE) → cache invalidated
  4. Request body assembled from chunks
  5. Load balancer picks a healthy upstream
  6. Worker process forwards request over keepAlive TCP
  7. Upstream responds → reply sent back via IPC
  8. Master sends response to client + caches (GET)
  9. On failure → circuit breaker records it, retry up to 2 times
```

---

## Performance Tips

- Set `workers` to `nproc` — never exceed your CPU core count
- Set `cache.enabled: true` for read-heavy APIs — reduces upstream load significantly
- Keep `autoScaling.maxServers` realistic for your hardware (3–4 for a 4-core machine)
- `keepAlive: true` is set by default — avoids TCP handshake overhead per request
- Monitor `/__lb-stats` in production to see which upstreams are under load

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss significant changes.

---

## License

MIT