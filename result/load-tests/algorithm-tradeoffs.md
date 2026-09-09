# 🧠 Subsystem & Algorithm Architecture Trade-Off Guide

This document records the architectural findings, trade-off analyses, and benchmark-backed conclusions for all algorithms implemented in the Ninja Reverse Proxy.

---

## 🏗️ 1. End-to-End System Pipeline Wiring

Every incoming HTTP request flows through a unified, high-performance middleware pipeline before routing and load balancing:

```
[Incoming Client Request]
          │
          ▼
[Master Process Cluster Manager (Port 9080)]
   ├── /metrics, /__ready, /__lb-stats  ──► [Admin Handler] (Direct Response)
   └── Application Traffic              ──► [Middleware Pipeline]
                                                  │
   ┌──────────────────────────────────────────────┴──────────────────────────────────────────────┐
   │ 1. CORS Middleware            ── Validate Allowed Origins, Methods, Headers                │
   │ 2. Tracing Middleware         ── Generate unique X-Request-Id (W3C TraceContext)           │
   │ 3. Body Limit Middleware      ── Enforce 10MB streaming payload ceiling                    │
   │ 4. Route Matcher              ── Prefix & Regex matching on path and method                │
   │ 5. Route Rate Limiter         ── Token-Bucket / Sliding-Window / Leaking-Bucket evaluation │
   │ 6. Cache Check                ── Fast-path L1 LRU & Redis cache hit lookup                 │
   │ 7. Load Balancer Strategy     ── Select healthiest upstream (P2C / Hash / WRR / RR / etc.) │
   └──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                                  │
                                                  ▼
                              [Master-to-Worker IPC Message Dispatch]
                                                  │
                                                  ▼
                               [Worker Process (Worker Pool)]
                                                  │
                                                  ▼
                        [Upstream Microservice (app-a, app-b, app-c, app-d)]
```

---

## ⚖️ 2. Load Balancing Algorithms: Complete Head-to-Head Analysis

The proxy implements **12 load balancing strategies** registered dynamically via `StrategyRegistry`:

### Comparative Matrix

| Algorithm | Decision Metric | Time Complexity | Space Complexity | Best Use Case | Behavior Under 1,000 VUs |
|---|---|---|---|---|---|
| **Power of Two Choices (P2C)** 🏆 | Samples 2 random nodes; picks the one with fewer `activeConnections`. | $O(1)$ | $O(1)$ | **Stateless APIs & High-Concurrency Microservices** | **Optimal**: Eliminates thundering herd and mutex locks; delivers lowest P99 latency. |
| **Consistent Hashing** | FNV-1a hash ring with 150 virtual nodes per server. | $O(\log V)$ | $O(V \cdot N)$ | **Distributed Caches & Stateful User Pinning** | **High Cache Affinity**: Guarantees the same key always routes to the same node (95%+ cache hit rate). |
| **Least-Connections** | Scans all nodes to find `min(activeConnections)`. | $O(N)$ | $O(1)$ | **Long-lived TCP / WebSocket connections** | **Prone to Thundering Herd**: Multiple workers pick the same idle node simultaneously during burst traffic. |
| **Round-Robin** | Simple circular modulo pointer. | $O(1)$ | $O(1)$ | **Identical backends with uniform request duration** | **Blind Routing**: If a backend stalls on a slow database query, Round-Robin keeps dumping traffic onto it. |
| **Weighted Round-Robin (WRR)**| Interleaved weighted counter with slow-start ramp. | $O(1)$ amortized | $O(N)$ | **Heterogeneous servers (e.g. 16-core + 4-core instances)** | **Predictable Ratio**: Routes traffic proportionally according to server capacity. |
| **Least-Response-Time** | EWMA smoothed latency ($\alpha = 0.1$). | $O(N)$ | $O(N)$ | **Networks with variable latency or cloud noisy-neighbors** | **Self-Healing**: Dynamically steers traffic away from slow/degraded instances. |
| **IP-Hash** | FNV-1a hash of client remote address. | $O(1)$ | $O(1)$ | **Basic session persistence without cookies** | **Uneven Clustering**: Behind corporate NATs, thousands of users share one IP, causing hot spots. |
| **Sticky-Sessions** | Reads `NINJA_ROUTE` cookie; falls back to round-robin. | $O(1)$ | $O(1)$ | **Stateful Web Apps (Shopping carts, checkout wizards)** | **100% Session Affinity**: Preserves user state across requests with zero cross-worker leakage. |
| **Adaptive-WRR** | Adjusts weights dynamically based on error rate & EWMA. | $O(N)$ | $O(N)$ | **Autonomous self-healing infrastructure** | **Automatic Degrade Protection**: Automatically lowers weight of error-prone backends. |
| **Resource-Based** | Telemetry feedback (CPU & memory usage). | $O(N)$ | $O(N)$ | **Compute-heavy workloads (video/image processing)** | **Hardware-Aware**: Prevents CPU throttling by routing away from overloaded nodes. |
| **Random** | Random integer selection. | $O(1)$ | $O(1)$ | **Massive server pools ($N > 100$)** | **Good statistical spread**, but can cause short-term hot spots. |
| **Weighted-Least-Connections**| `activeConnections / weight`. | $O(N)$ | $O(1)$ | **Heterogeneous server pools with variable connection lengths**| Balances capacity-weighted connection load. |

---

## 🛡️ 3. Rate Limiting Algorithms: Complete Comparative Analysis

The proxy provides **5 distinct rate limiting algorithms** selectable per-route or globally:

### Comparative Matrix

| Algorithm | Algorithm Mechanics | Time Complexity | Memory Complexity | Burst Tolerance | Flaw / Trade-off | Best Production Fit |
|---|---|---|---|---|---|---|
| **Token Bucket** 🏆 | Refills tokens at steady rate up to bucket capacity. Requests consume 1 token. | $O(1)$ | $O(1)$ (2 numbers per user) | **High (Allows natural bursts)** | Permissive: allows burst traffic up to capacity. | **Public Web & Mobile APIs** (Smooth user experience on page bootup). |
| **Sliding Window Counter** 🥈 | Blends count of previous window and current window via weighted time fraction. | $O(1)$ | $O(1)$ (2 counters per user) | **Smooth (No boundary burst)** | Small statistical approximation error (< 0.05%). | **Financial Transactions & High-Frequency Microservices**. |
| **Leaking Bucket** | Requests enter a FIFO queue and leak out at a strictly constant rate. | $O(1)$ | $O(1)$ or $O(Q)$ | **Zero (Strictly constant rate)** | Rejects or delays bursts immediately, hurting interactive web UX. | **Third-Party API Gateways (Stripe, Twilio, SMS rate limits)**. |
| **Fixed Window** | Counts requests in a fixed time window; resets counter at window edge. | $O(1)$ | $O(1)$ (1 counter per user) | **Boundary Spike Flaw** | Double rate at boundary: client can send 2x quota in 2 seconds. | **Basic internal microservice rate limiting**. |
| **Sliding Window Log** | Stores every timestamp in an array; counts entries within `now - windowMs`. | $O(\log N)$ | $O(N)$ (High memory per user) | **Exact / Perfect Precision** | Memory explodes under heavy load (storing thousands of timestamps per IP). | **Strict Security Audits & Login Brute-Force Defense**. |

---

## 🔄 4. Resilience Subsystems

### Circuit Breakers
- **Classic Circuit Breaker**: Three states (`CLOSED` ──► `OPEN` ──► `HALF_OPEN`). Trips immediately after $N$ consecutive failures. Trips all-or-nothing.
- **Adaptive Circuit Breaker (Google SRE EWMA)**: Calculates drop probability $P_{\text{drop}} = \max(0, \frac{\text{requests} - K \cdot \text{accepts}}{\text{requests} + 1})$. Instead of a binary hard cut-off, it probabilistically sheds a percentage of traffic as errors rise, allowing degraded backends to recover smoothly without thundering herd recoveries.

### Retry Backoff Strategies
- **Deterministic Exponential**: $\text{delay} = \min(\text{maxDelay}, \text{baseDelay} \cdot 2^{\text{attempt}})$. Problem: causes synchronized retry storms across clients.
- **Full Jitter**: $\text{delay} = \text{random}(0, \min(\text{maxDelay}, \text{baseDelay} \cdot 2^{\text{attempt}}))$. **Recommended**: Completely desynchronizes client retries.
- **Equal Jitter**: $\text{delay} = \frac{\text{temp}}{2} + \text{random}(0, \frac{\text{temp}}{2})$. Guarantees a minimum baseline delay with random jitter.
- **Decorrelated Jitter**: $\text{delay} = \min(\text{maxDelay}, \text{random}(\text{baseDelay}, \text{prevSleep} \cdot 3))$. Increases sleep proportionally based on the previous attempt's duration.

---

## 📈 5. Empirical Benchmark Summary (1,000 Concurrent Virtual Users)

From our hyperscale load test on an **Apple M5 10-Core** with 6 clustered workers:

```
Total Requests Processed: 627,212
Global Error Rate:        0.00%
Peak RPS (Rate Limiter):  17,750 req/s
Peak RPS (P2C Router):    6,650 req/s (doing real GET, POST JSON, PUT mutations)
Max RSS Memory:           150.2 MB (Strictly bounded)
P50 Latency (1K VUs):     155.08 ms
P99 Latency (1K VUs):     327.38 ms
```

---

## 🎯 6. Interview "Golden Blueprints"

When asked how to architect and configure this reverse proxy for specific industry workloads:

1. **High-Throughput E-Commerce & Web**:
   - `loadBalancing: power-of-two` (eliminates thundering herd)
   - `rateLimit: token-bucket` (allows natural page load burst)
   - `cache: hybrid` (L1 LRU memory + Redis)
   - `resilience: adaptive` (Google SRE probabilistic shedding)

2. **Banking, Payments & Fintech**:
   - `loadBalancing: power-of-two`
   - `rateLimit: sliding-window-counter` (mathematical smoothing across boundary edges)
   - `retry: full-jitter` (desynchronized retry storms with 15% retry budget)
   - `circuitBreaker: classic` (deterministic cut-off on 5xx errors)

3. **Distributed Caching & Stateful Gaming/Chat**:
   - `loadBalancing: consistent-hashing` (virtual node ring for 95%+ cache hit rate)
   - `stickyCookieName: NINJA_ROUTE` (session continuity across workers)
