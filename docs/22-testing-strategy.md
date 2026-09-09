# 🧪 Testing Architecture & Verification Strategy

## Overview
A reverse proxy sits directly on the critical path of all application traffic. An uncaught bug (such as an unhandled socket drop, a race condition in connection pooling, or a memory leak in header parsing) brings down all downstream services.

Ninja Reverse Proxy employs a strict, multi-tier testing pyramid to guarantee 100% reliability prior to production deployment.

```
                     ▲
                    / \
                   /   \
                  / k6  \        Level 5: Load & Stress Testing
                 / Load  \       (Throughput ceiling, P99 latency, soak)
                /─────────\
               /   Chaos   \     Level 4: Fault Injection & Failover
              / Resilience  \    (Killing nodes mid-traffic, packet drops)
             /───────────────\
            /   Universal     \  Level 3: Strict Real-App Integration
           /   Integration     \ (E2E HTML, WebSocket 101, CORS, Retry)
          /─────────────────────\
         /     Live Smoke        \ Level 2: Protocol Transport Smoke
        /   (TLS, 8080 Redirect)  \ (Ports, TLS certs, Prometheus scrape)
       /───────────────────────────\
      /    Unit & Subsystem Audit   \ Level 1: In-Memory Mathematical Audit
     /       (183 Strict Tests)      \ (12 LB algos, 5 Rate limiters, LRU)
    /─────────────────────────────────\
```

---

## 1. The 5 Testing Tiers

### Tier 1: In-Memory Unit & Subsystem Audit
* **Command**: `npm run test:audit`
* **Test Count**: 183 tests across 7 subsystems.
* **Scope**: Runs in-memory with zero network overhead. Tests exact mathematical formulas (e.g. Google SRE drop probability, Ketama hash distribution, Token Bucket refill rate, LRU eviction order).

### Tier 2: Protocol & Network Smoke Testing
* **Command**: `npm run test:live`
* **Scope**: Validates that port 8080 auto-redirects to port 8443, TLS handshakes succeed without certificate negotiation errors, and Prometheus `/metrics` emits OpenMetrics text.

### Tier 3: Strict Real-Application Integration Testing
* **Command**: `npm run test:universal`
* **Scope**: Verifies real-world edge cases against a live backend (e.g. Chess backend):
  * Real HTML markup delivery (not just status 200).
  * CORS preflight `OPTIONS` requests.
  * Distributed trace header injection (`X-Trace-Id`).
  * Sticky session cookie (`NINJA_ROUTE`) pinning across 4 consecutive requests.
  * Real Socket.IO WebSocket upgrade negotiation (`101 Switching Protocols`).
  * Slow backend handling (`/slow` delay $\ge 800$ms) without dropped sockets.
  * Automatic retry on flaky upstreams (`/flake` 503 $\to$ 200 OK).
  * 30 parallel concurrent requests without dropped connections.

### Tier 4: Chaos & Fault Tolerance Testing
* **Command**: `tests/chaos/upstream-failure.chaos.ts`
* **Scope**: Simulates unannounced upstream failure (killing backend processes), network partitions, and verifies that the passive health probe marks the node dead and reroutes 100% of traffic to healthy nodes with zero customer-facing 502 errors.

### Tier 5: High-Concurrency Load & Stress Testing
* **Tool**: k6 / Autocannon
* **Scripts**:
  * `tests/load/k6/smoke.js`: 1 VU, 30s baseline sanity check.
  * `tests/load/k6/stress.js`: Ramp to 200 concurrent users over 9 minutes.
  * `tests/load/k6/spike.js`: Burst to 500 VUs to verify circuit breaker trip and rate limiter protection.

---

## 2. Strict Assertion Policy (No "Fake" Simulation)

In low-quality test suites, tests often use loose assertions such as:
```javascript
// ❌ REJECTED: Loose check allows broken features returning 404 to pass!
assert(response.statusCode !== 502);
```

In Ninja Reverse Proxy, **all integration tests use strict assertions**:
```javascript
// ✅ ENFORCED: Strict validation of exact application state
assert.strictEqual(response.statusCode, 200);
assert.ok(response.body.includes("Chess"));
assert.strictEqual(firstHitTarget, secondHitTarget);
```

---

## 3. Pre-Flight Load Testing Checklist

Before initiating sustained load testing (e.g. `k6 run tests/load/k6/stress.js`):
1. `npm run build` completed with 0 TypeScript errors.
2. `npm run test:audit` passed (183/183).
3. `npm run test:universal` passed (10/10 against live backends).
4. Monitoring stack running (`docker compose -f deploy/monitoring/docker-compose.monitoring.yml up -d`).
5. Open `http://localhost:3000` to observe live Prometheus/Grafana graphs during the benchmark.
