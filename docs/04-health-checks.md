# 🏥 Health Checks — How It Works

## What Is Health Checking?

Proxy constantly monitors backend servers. If a backend goes down, the proxy **stops sending traffic to it** and only resumes when it recovers. Without this, requests would fail until manually fixed.

---

## Two Types of Health Probes

### 1. Active Probe — Periodic HTTP Ping

Proxy itself sends an HTTP GET to each upstream's health endpoint every N seconds:

```typescript
// active.probe.ts
async function checkUpstream(upstream) {
    const res = await fetch(`${upstream.url}${upstream.healthPath}`, {
        signal: AbortSignal.timeout(httpTimeoutMs),
    });
    return res.ok; // 2xx = healthy
}
```

If response is `2xx` → upstream is healthy.
If timeout or non-2xx → increment failure count.

After `unhealthyThreshold` consecutive failures → mark UNHEALTHY → stop sending traffic.
After `healthyThreshold` consecutive successes → mark HEALTHY again → resume traffic.

---

### 2. Passive Probe — Failure Detection During Real Traffic

While proxying real requests, if an upstream returns 5xx or times out:

```typescript
// passive.probe.ts
onUpstreamFailure(upstreamId) {
    failureCount[upstreamId]++;
    if (failureCount[upstreamId] >= threshold) {
        markUnhealthy(upstreamId);
    }
}
```

No extra network overhead — piggybacks on real traffic.

---

## Health State Machine

```
          ┌─────────┐
          │ HEALTHY │ ◄──── healthyThreshold consecutive successes
          └────┬────┘
               │ unhealthyThreshold consecutive failures
               ▼
         ┌──────────┐
         │UNHEALTHY │
         └──────────┘
```

Load balancer **only picks from `HEALTHY_UPSTREAMS` set**:

```typescript
// master.ts
const HEALTHY_UPSTREAMS: Set<string> = new Set();

// Health manager updates this set
HEALTHY_UPSTREAMS.add(upstreamId);    // when healthy
HEALTHY_UPSTREAMS.delete(upstreamId); // when unhealthy

// Load balancer filters
lb.pickFiltered(HEALTHY_UPSTREAMS, ...);
```

---

## Initial Health Check on Startup

```typescript
// health.manager.ts
async function initialCheck() {
    const results = await Promise.all(upstreams.map(checkUpstream));
    // Only start serving traffic after at least one upstream is healthy
    const healthy = results.filter(Boolean);
    logger.info("HealthCheck", `Initial check done`, { healthy });
}
```

Proxy runs one health check on ALL upstreams before accepting any traffic. Prevents sending requests to an upstream that hasn't started yet.

---

## proxy.yaml Config

```yaml
discovery:
  healthCheckIntervalMs: 10000   # check every 10 seconds
  unhealthyThreshold: 3          # 3 failures → mark unhealthy
  healthyThreshold: 2            # 2 successes → mark healthy again
  httpTimeoutMs: 2000            # give 2 seconds per ping

upstreams:
  - id: chess-backend
    url: "http://127.0.0.1:3009"
    healthPath: "/"              # ping this path
```

---

## What You See in Logs

```
[HealthCheck] Initial health check started
[HealthCheck] chess-backend is HEALTHY
[HealthCheck] Initial check done {"healthy":["chess-backend"]}
[HealthCheck] Periodic health checks started {"interval":10000}
[HealthCheck] Checking all upstreams           ← every 10 seconds
```

---