# Using Ninja Reverse Proxy with Express.js

This example shows how to integrate any **Express.js** application with Ninja Reverse Proxy.

The same pattern works for any HTTP backend — Express is just one example.

---

## How it works

The proxy uses a **Service Registry**. Instead of hardcoding backend URLs inside the proxy, each backend registers itself at startup via a `POST /__registry/register` request. This means:

- The proxy starts first
- Your backend starts and registers itself
- The proxy adds it to load balancing rotation automatically
- Periodic heartbeats keep the backend marked as healthy

If a backend goes down, it automatically gets removed from rotation.

---

## Quick Start

### 1. Install Express

```bash
cd examples/express
npm init -y
npm install express
```

### 2. Set environment variables and run

```bash
SERVER_ID=my-express \
SERVER_PORT=3001 \
PROXY_HOST=localhost \
PROXY_PORT=8080 \
node server.js
```

### 3. Configure the proxy

In your `config.yaml` add:

```yaml
upstreams:
  - id: my-express
    url: http://localhost:3001

paths:
  - path: /
    upstream:
      - my-express
```

### 4. Test via the proxy

```bash
curl -k https://localhost:8443/
curl -k https://localhost:8443/api/users
```

---

## Running with Docker Compose

Add your Express app as a service in your project's `docker-compose.yml`:

```yaml
services:

  my-express-app:
    build: ./my-express-app
    environment:
      SERVER_ID: my-express-app
      SERVER_PORT: 3001
      PROXY_HOST: proxy
      PROXY_PORT: 8080
    networks:
      - proxy-network
    ports:
      - "3001:3001"

  # proxy and redis services from the main docker-compose.yml...
```

And in `config.yaml`:

```yaml
upstreams:
  - id: my-express-app
    url: http://my-express-app:3001

paths:
  - path: /api
    upstream:
      - my-express-app
```

---

## Health Endpoint

The proxy health checker calls `GET /health` on every upstream every 10 seconds.

Your backend **must** respond with HTTP `200` on `/health`:

```js
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP' });
});
```

Backends that fail health checks are removed from load balancing rotation and automatically re-added when they recover.

---

## The same pattern works for any backend

You do not need the service registry integration code if you are listing upstreams statically in `config.yaml`. The integration code (`registerSelf`, `sendHeartbeat`) is only needed if you want **dynamic registration** (useful for auto-scaling).

For **static backends** (most production setups), just list them in `config.yaml`:

```yaml
upstreams:
  - id: my-django-app
    url: http://my-django-app:8000

  - id: my-spring-boot
    url: http://my-spring-boot:8080
```

That is all. The proxy handles the rest.
