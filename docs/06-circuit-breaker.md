# ⚡ Circuit Breaker & Resilience — How It Works

## What Is a Circuit Breaker?

Named after electrical circuit breakers. When a backend fails repeatedly, instead of hammering it with more requests (making it worse), the circuit breaker **opens** and rejects requests immediately — giving the backend time to recover.

---

## The 3 States

```
         failures >= threshold
CLOSED ─────────────────────────► OPEN
  │                                 │
  │ (requests flow normally)        │ (reject all — 503 immediately)
  │                                 │
  │◄────────────────────────────────│
half-open successes >= threshold   recoveryTimeMs elapsed
                                     │
                                     ▼
                                 HALF-OPEN
                             (allow 1 test request)
```

- **CLOSED**: Normal. All requests go through. Failure count tracked.
- **OPEN**: Backend is down. All requests rejected with `503` instantly. No network call made.
- **HALF-OPEN**: After `recoveryTimeMs`, allow 1 request as a test. Success → CLOSED. Failure → OPEN again.

---

## Classic Circuit Breaker (Code)

```typescript
// circuit.middleware.ts
if (state === "OPEN") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Circuit open — upstream unavailable" }));
    return;  // zero network overhead
}

// proxy the request...
if (response.status >= 500) {
    failureCount++;
    if (failureCount >= failureThreshold) {
        state = "OPEN";
        setTimeout(() => { state = "HALF_OPEN"; }, recoveryTimeMs);
    }
}
```

---

## Google SRE Adaptive Circuit Breaker

Instead of hard failure count, uses **probability-based request shedding**:

```
P(reject) = (requests - K × accepts) / (requests + 1)
```

Where:
- `requests` = total requests in sliding window
- `accepts` = requests that succeeded
- `K` = multiplier (configured, e.g. 2)

| requests | accepts | K | P(reject) | Behaviour |
|---|---|---|---|---|
| 100 | 90 | 2 | (100-180)/101 = **0** | No rejection |
| 100 | 40 | 2 | (100-80)/101 = **0.20** | 20% rejected |
| 100 | 10 | 2 | (100-20)/101 = **0.79** | 79% rejected |

Gradually sheds load proportional to backend health — no sudden all-or-nothing cutoff.

---

## Bulkhead Pattern

Isolates connection slots per upstream. Prevents one slow upstream from consuming all worker capacity.

```typescript
// bulkhead.middleware.ts
if (activeConnections[upstreamId] >= maxConcurrent) {
    res.writeHead(503, { "Retry-After": "1" });
    res.end(JSON.stringify({ error: "Bulkhead full — try again" }));
    return;
}
activeConnections[upstreamId]++;
// ... proxy ...
activeConnections[upstreamId]--;
```

Without bulkhead: one slow upstream fills all 100 connection slots → other upstreams starve.
With bulkhead: each upstream gets max N slots → failures stay isolated.

---

## Retry with Jitter Backoff (4 Algorithms)

### Full Jitter (Recommended)
```typescript
delay = Random(0, min(cap, base * 2^attempt))

// base=100ms, cap=5000ms:
Attempt 1: Random(0, 200ms)
Attempt 2: Random(0, 400ms)
Attempt 3: Random(0, 800ms)
Attempt 4: Random(0, 1600ms)
```

**Why jitter?** Without randomness, all retrying clients retry at the exact same moment → synchronized thundering herd → crashes the recovering backend again.

### Other Algorithms
```typescript
// Equal Jitter
delay = temp/2 + Random(0, temp/2)

// Decorrelated Jitter (AWS recommended)
delay = Random(base, previousSleep * 3)

// Exponential (no jitter — avoid in distributed systems)
delay = min(cap, base * 2^attempt)
```

---

## Retry Budget

```typescript
// Max 15% of total traffic can be retries
const retryBudget = totalRequests * 0.15;
if (retryCount > retryBudget) {
    throw new Error("Retry budget exhausted — stop retrying");
}
```

Prevents retry storms — if all requests fail, retries would multiply traffic by `maxAttempts` and DDoS a recovering backend.

---

## proxy.yaml Config

```yaml
resilience:
  retry:
    enabled: true
    maxAttempts: 3
    backoff: full-jitter        # exponential | full-jitter | equal-jitter | decorrelated-jitter
    baseDelayMs: 100
    maxDelayMs: 5000
    budgetPercent: 15           # max 15% of traffic can be retries
  circuitBreaker:
    mode: classic               # classic | adaptive
    failureThreshold: 5         # failures before opening
    recoveryTimeMs: 10000       # wait 10s before testing recovery
    K: 2                        # adaptive only — aggressiveness multiplier
  bulkhead:
    enabled: true
    maxConcurrentPerUpstream: 100
```

---
