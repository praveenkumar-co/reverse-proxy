# 🚦 Health Gating: Readiness vs. Liveness Probes

## Overview
In production container environments (Kubernetes, AWS ECS, Docker Swarm), routing traffic to a proxy instance before its internal subsystems (Redis, TLS certificates, service registry, worker sockets) are initialized leads to a flurry of `502 Bad Gateway` and `503 Service Unavailable` errors during deployment rollouts.

Ninja Reverse Proxy implements explicit **Readiness and Liveness gating** via `ReadinessProbe`.

```
Pod Startup / Process Launch
            │
            ▼
┌───────────────────────────────────────┐
│ ReadinessProbe.isReady()              │
│ Evaluates registered health checks:   │
│  - tlsCertificatesValid: true/false   │
│  - redisConnected: true/false         │
│  - healthyUpstreamsCount > 0          │
└──────────────────┬────────────────────┘
                   │
         PASS ─────┴───── FAIL
          │                 │
          ▼                 ▼
   Return HTTP 200    Return HTTP 503
   Traffic Allowed    Container traffic blocked /
                      Load balancer waits
```

---

## 1. Readiness vs. Liveness Distinction

| Probe Type | Endpoint | Purpose | Action on Failure |
|---|---|---|---|
| **Liveness** | `/healthz` or `/live` | Checks if the Node.js event loop is running and process is not deadlocked. | Orchestrator terminates and restarts the container. |
| **Readiness** | `/ready` or `/readiness` | Checks if proxy is fully initialized and can accept customer traffic. | Orchestrator stops routing traffic to this pod without killing it. |

---

## 2. Implementation (`src/observability/health/readiness.ts`)

```typescript
export interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
}

export class ReadinessProbe {
  private checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async isReady(): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    const results: Record<string, boolean> = {};
    let allReady = true;

    for (const { name, check } of this.checks) {
      try {
        const ok = await check();
        results[name] = ok;
        if (!ok) allReady = false;
      } catch {
        results[name] = false;
        allReady = false;
      }
    }

    return { ready: allReady, checks: results };
  }
}
```

---

## 3. Initial Health Check Gate at Startup

During master startup in `src/core/cluster/master.ts`, the proxy runs an initial health check against all configured backends before opening the external HTTP/HTTPS listener:

```typescript
// Initial health check on startup
logger.info("HealthCheck", "Running initial health check on upstreams...");
await healthManager.checkAll();

const healthyCount = HEALTHY_UPSTREAMS.size;
if (healthyCount === 0) {
  logger.warn("HealthCheck", "Zero upstreams are healthy on startup! Traffic will 503 until backends come online.");
} else {
  logger.info("HealthCheck", `Initial health check complete. ${healthyCount} upstreams healthy.`);
}
```

---

## 4. Kubernetes Deployment Manifest Example

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 2
  periodSeconds: 5
  failureThreshold: 2
```
