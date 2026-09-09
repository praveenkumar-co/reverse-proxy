# 🔁 Retry & Bulkhead Resilience Patterns

## Overview
Cascading failure occurs when an upstream degrades, causing request queues to inflate, thread pools to exhaust, and client timeouts to trigger aggressive retry storms. The Resilience subsystem isolates concurrency via the **Bulkhead** pattern and bounds retry volume via **RetryBudget** and **Jittered Backoff**.

```
Incoming Request
      │
      ▼
┌───────────────────────────────────────┐
│ Bulkhead (per upstream concurrency)   │
│  activeCount < maxConcurrent?         │
└──────────────────┬────────────────────┘
                   │
         YES ──────┴────── NO ──► 503 Service Unavailable ("Bulkhead full")
          ▼
┌───────────────────────────────────────┐
│ RetryHandler.execute(fn, maxAttempts) │
│                                       │
│  Attempt 1 ──► Upstream               │
│     │ (Network error / 5xx)           │
│     ▼                                 │
│  RetryBudget.recordRetry()            │
│     │                                 │
│  Allowed? ─── NO ──► Return Failure   │
│     │ (YES)                           │
│     ▼                                 │
│  Backoff Delay (Jittered)             │
│     ▼                                 │
│  Attempt 2 ──► Upstream (Success!)    │
└───────────────────────────────────────┘
```

---

## 1. Bulkhead Concurrency Limiter

The Bulkhead pattern isolates upstream resource consumption. A single degraded upstream cannot consume all connection slots in the proxy.

### Core Interface (`src/resilience/bulkhead/bulkhead.ts`)
```typescript
export class Bulkhead {
  constructor(private readonly maxConcurrent: number) {}

  enter(): boolean;               // acquire slot (atomic)
  leave(): void;                  // release slot (in finally block)
  getActiveCount(): number;       // current in-flight requests
  getMaxConcurrent(): number;     // configured ceiling
  execute<T>(fn: () => Promise<T>): Promise<T>;
}
```

### Execution Semantics
- `enter()` increments internal counter if `activeCount < maxConcurrent`. Returns `false` if saturated.
- Rejection produces an immediate `503 Service Unavailable` with `Retry-After: 1` header. Zero network I/O is dispatched to the saturated backend.
- Always release slots in `finally` to prevent slot leaks:
```typescript
if (!bulkhead.enter()) {
  res.writeHead(503, { "Retry-After": "1" });
  return res.end(JSON.stringify({ error: "Bulkhead capacity saturated" }));
}
try {
  await forwardRequest(req, res);
} finally {
  bulkhead.leave();
}
```

---

## 2. Retry Handler & Retry Budget

### Why Retries Need a Budget
Unconstrained retries multiply traffic during outages. If an upstream is failing 100% of requests, a naive retry policy of `maxAttempts: 3` triples traffic to an already dead server.

A **Retry Budget** limits retries to a fixed percentage of total incoming traffic (e.g. 15–20%):

$$\text{RetryRatio} = \frac{\text{TotalRetries}}{\text{TotalRequests}} \le \text{BudgetPercent}$$

### Implementation (`src/resilience/retry/retry-budget.ts`)
```typescript
export class RetryBudget {
  constructor(
    private budgetPercent: number = 20,
    private decayFactor: number = 0.95
  ) {}

  recordRequest(): void;          // records incoming valid request
  recordRetry(): boolean;         // returns true if retry allowed under budget
  getStats(): { totalRequests: number; totalRetries: number; ratio: number };
}
```

---

## 3. Backoff Algorithms with Jitter

Synchronized retries create thundering herd spikes. Jitter decorrelates client retry timings across a cluster.

### Four Implemented Algorithms

| Algorithm | Formula | Characteristics |
|---|---|---|
| **Full Jitter** | $t = \text{random}(0, \min(\text{cap}, \text{base} \times 2^{\text{attempt}}))$ | Maximum spread; lowest synchronization. |
| **Equal Jitter** | $t_{\text{half}} = \frac{\text{temp}}{2}; t = t_{\text{half}} + \text{random}(0, t_{\text{half}})$ | Guarantees minimum wait while adding variance. |
| **Decorrelated Jitter** | $t = \min(\text{cap}, \text{random}(\text{base}, \text{prevDelay} \times 3))$ | AWS recommended; memory of previous delay. |
| **Exponential** | $t = \min(\text{cap}, \text{base} \times 2^{\text{attempt}})$ | Deterministic backoff; no randomness. |

---

## Configuration (`proxy.yaml`)

```yaml
resilience:
  bulkhead:
    enabled: true
    maxConcurrentPerUpstream: 100

  retry:
    enabled: true
    maxAttempts: 3
    backoff: full-jitter          # full-jitter | equal-jitter | decorrelated-jitter | exponential
    baseDelayMs: 200
    maxDelayMs: 3000
    budgetPercent: 20             # Max 20% of requests can be retries
```

---

## Operational Edge Cases & Gotchas

1. **Idempotency Guard**: By default, only safe HTTP verbs (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`) should be retried automatically. Unsafe `POST` requests should not be retried unless explicitly configured with idempotency keys to prevent duplicate database writes.
2. **Socket Destruction Cleanup**: If an upstream connection drops abruptly, ensure `bulkhead.leave()` is called on stream error events, otherwise active slots will be leaked permanently.
