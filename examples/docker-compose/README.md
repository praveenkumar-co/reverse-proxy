# Demo Stack — Docker Compose

This directory contains the **built-in demo** for Ninja Reverse Proxy.

It is a self-contained example that spins up two minimal Node.js backend servers
(`backend-a` and `backend-b`) alongside the proxy and Redis — so you can see the
proxy working immediately without wiring up a real application.

> **This is only a demo.**
> For production use, replace the backend services with your own application.

---

## What is inside

| File | Purpose |
|---|---|
| `server-template.js` | Minimal Node.js HTTP server. Handles `/health`, GET, POST, PUT, PATCH, DELETE. Registers itself with the proxy service registry on start. |
| `Dockerfile.server` | Docker image for `server-template.js` |
| `docker-compose.yml` | Full demo stack: proxy + Redis + backend-a + backend-b |

---

## Prerequisites

- Docker and Docker Compose installed
- SSL certificates in the **project root** (`key.pem`, `cert.pem`)

Generate a self-signed certificate if you do not have one:

```bash
# Run this from the project root (not from inside examples/)
openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem -out cert.pem \
  -days 365 -nodes
```

---

## How to run the demo

```bash
# From the project root
cd examples/docker-compose

docker-compose up --build
```

The following services will start:

| Service | Port | Description |
|---|---|---|
| `proxy` | `8080` (HTTP → HTTPS), `8443` (HTTPS) | Ninja Reverse Proxy |
| `redis` | internal | Response cache |
| `backend-a` | `3001` | Demo backend server A |
| `backend-b` | `3002` | Demo backend server B |

---

## Verify it works

```bash
# Check proxy is up and both backends are registered
curl -k https://localhost:8443/__registry

# Check load balancer stats
curl -k https://localhost:8443/__lb-stats

# Send a test request (will round-robin between backend-a and backend-b)
curl -k https://localhost:8443/
```

---

## Stop the demo

```bash
docker-compose down
```
