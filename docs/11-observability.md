# 📊 Observability — Metrics, Logging & Dashboards

## What Is Observability?

Observability means being able to understand what your system is doing internally — by looking at metrics, logs, and traces. The three pillars: **Metrics, Logs, Traces**.

---

## 1. Prometheus Metrics Endpoint

Proxy exposes `/metrics` in Prometheus exposition format:

```bash
curl http://localhost:8080/metrics
# or
curl https://localhost:8443/metrics
```

Sample output:
```
# HELP proxy_requests_total Total requests proxied
# TYPE proxy_requests_total counter
proxy_requests_total{upstream="chess-backend",status="200"} 1523

# HELP proxy_latency_p99 P99 request latency in ms
# TYPE proxy_latency_p99 gauge
proxy_latency_p99{upstream="chess-backend"} 45.2

# HELP proxy_active_connections Current active connections
# TYPE proxy_active_connections gauge
proxy_active_connections{upstream="chess-backend"} 3

# HELP proxy_circuit_breaker_state Circuit breaker state (0=closed, 1=open)
proxy_circuit_breaker_state{upstream="chess-backend"} 0
```

---

## 2. Metrics Collected

| Metric | Type | Description |
|--------|------|-------------|
| `proxy_requests_total` | Counter | Total requests per upstream per status code |
| `proxy_latency_p50/p95/p99` | Gauge | Latency percentiles (EWMA) |
| `proxy_active_connections` | Gauge | Live connections per upstream |
| `proxy_circuit_breaker_state` | Gauge | 0=closed, 1=open |
| `proxy_rate_limit_rejected_total` | Counter | Requests rejected by rate limiter |
| `proxy_cache_hits_total` | Counter | L1 + L2 cache hits |
| `proxy_upstream_health` | Gauge | 1=healthy, 0=unhealthy |

---

## 3. Multi-Worker Metrics Aggregation

Each worker tracks its own metrics. Master collects them all:

```typescript
// master.ts — when /metrics is requested
async function collectWorkerMetricSnapshots() {
    const promises = WORKER_POOL.map(worker => {
        return new Promise(resolve => {
            worker.send({ type: 'METRICS_REQUEST' });
            worker.once('message', msg => {
                if (msg.type === 'METRICS_SNAPSHOT') resolve(msg.data);
            });
        });
    });
    return Promise.all(promises); // collect from all workers
}
```

All worker snapshots are merged and returned as one unified `/metrics` response.

---

## 4. Structured JSON Logging

Every log line is JSON with timestamp, level, component, and message:

```json
{"timestamp":"2026-09-04T09:24:27.238Z","level":"INFO","component":"HealthCheck","message":"chess-backend is HEALTHY"}
{"timestamp":"2026-09-04T09:24:24.212Z","level":"INFO","component":"Registry","message":"Service REGISTERED","id":"chess-backend","url":"http://127.0.0.1:3009"}
```

Structured logs can be ingested by Elasticsearch, Loki, Datadog — enables searching and filtering.

---

## 5. Tenant Log Streamer (Webhook)

For multi-tenant deployments, each tenant gets their own access logs delivered via HTTP webhook:

```typescript
// Each request's access log delivered to tenant webhook
tenantLogStreamer.dispatch(tenantId, {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    status: res.statusCode,
    latencyMs: Date.now() - startTime,
    upstream: upstreamId,
    clientIP: clientIP,
});
```

```yaml
# proxy.yaml
observability:
  tenantDelivery:
    mode: webhook
    exportEndpoints:
      - tenantId: tenant-1
        url: https://tenant1.example.com/logs
```

---

## 6. Load Balancer Stats Endpoint

```bash
curl http://localhost:8080/__lb-stats
```

```json
{
  "strategy": "round-robin",
  "upstreams": [
    { "id": "chess-backend", "activeConnections": 3, "totalRequests": 1523, "avgLatencyMs": 12.4 }
  ],
  "healthyUpstreams": ["chess-backend"]
}
```

---
