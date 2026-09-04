# ⚖️ Load Balancing — How It Works

## What Is Load Balancing?

When you have multiple backend servers, a load balancer decides **which server handles each incoming request**. Goal: spread traffic evenly so no single server is overwhelmed.

---

## Architecture

```
Request arrives
      ↓
Load Balancer (picks upstream)
      ↓
  ┌───────────────────────────────────┐
  │  Strategy (e.g. round-robin)     │
  │  + Health filter (only healthy)  │
  │  + Connection count tracking     │
  └───────────────────────────────────┘
      ↓
Picks: chess-backend (127.0.0.1:3009)
      ↓
Proxy forwards request there
```

---

## The 12 Strategies

| Strategy | Algorithm | Best For |
|---|---|---|
| **Round Robin** | Cycle through upstreams in order | Equal servers, simple |
| **Weighted Round Robin** | Give more turns to higher-weight upstreams | Servers with different capacity |
| **Adaptive WRR** | Dynamically adjusts weights based on real latency | Auto-tuning |
| **Least Connections** | Always pick upstream with fewest active connections | Long-lived connections |
| **Weighted Least Connections** | `activeConnections / weight` ratio | Mixed capacity + long connections |
| **Least Response Time** | Pick upstream with lowest latency EWMA | Latency-sensitive APIs |
| **Power of Two Choices (P2C)** | Pick 2 random, choose better one | Large clusters, O(1) |
| **Consistent Hashing** | Hash client IP to upstream (150 virtual nodes) | Cache locality |
| **IP Hash** | FNV-1a hash of client IP modulo upstream count | Session affinity |
| **Sticky Sessions** | Cookie-based (`NINJA_ROUTE`) session pinning | Stateful apps |
| **Resource-Based** | Routes based on live CPU/memory metrics from sidecars | CPU-intensive workloads |
| **Random** | Pick random healthy upstream | Simple fallback |

---

## Code Flow — How a Request Gets Routed

```typescript
// master.ts
const upstreamId = lb.pickFiltered(
    routeHealthyUpstreams,  // only healthy upstreams for this route
    clientIP,               // for IP-based strategies
    new Set(),              // already-tried upstreams (for retry logic)
    req.headers.cookie,     // for sticky sessions
);

lb.incrementConnection(upstreamId);  // track active connections
// ... proxy the request ...
lb.releaseConnection(upstreamId);    // release when done
```

---

## Weighted Round Robin — Deep Dive (NGINX Algorithm)

```typescript
// Each upstream has:
// weight: configured capacity (e.g. 3)
// currentWeight: running score

pick() {
    let best = null;
    for (const upstream of upstreams) {
        upstream.currentWeight += upstream.weight;  // add own weight
        if (!best || upstream.currentWeight > best.currentWeight) {
            best = upstream;
        }
    }
    best.currentWeight -= totalWeight;  // penalize winner
    return best.id;
}
```

Example with weights [3, 1]:
```
Round 1: A gets +3 → [3,1]  → pick A → A becomes [-1,1]
Round 2: A gets +3 → [2,1]  → pick A → A becomes [-2,1]
Round 3: A gets +3 → [1,1]  → tie → pick A → A becomes [-3,1]
Round 4: B gets +1 → [-2,2] → pick B → B becomes [-2,-2]
→ Pattern: A, A, A, B, A, A, A, B... (3:1 ratio)
```

---

## Consistent Hashing — Deep Dive

Used when you need the **same client to always hit the same upstream** (cache locality).

```typescript
// 150 virtual nodes per upstream on a ring
ring = {
  hash("chess-backend-0"):  upstream-A,
  hash("chess-backend-1"):  upstream-A,
  ...
  hash("chess-backend-149"): upstream-A,
  hash("backend-b-0"):       upstream-B,
  ...
}

// Client IP hashed → find nearest node on ring clockwise
clientHash = fnv1a("192.168.1.1");
upstream = ring.findNearest(clientHash);
```

**Benefit**: When an upstream is added/removed, only `1/N` of clients reroute. Without consistent hashing, ALL clients reroute.

---