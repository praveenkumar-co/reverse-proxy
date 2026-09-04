# 🚦 Rate Limiting — How It Works

## What Is Rate Limiting?

Controls how many requests a client can make in a given time window. Protects backends from being overwhelmed by too many requests — whether from abuse, bots, or a buggy client.

---

## The 5 Algorithms

### 1. Token Bucket
Imagine a bucket that holds tokens. Each request consumes 1 token. Tokens refill at a fixed rate.

```
Bucket capacity: 100 tokens
Refill rate: 10 tokens/second

Request comes in → take 1 token → allow
Bucket empty → reject with 429
Time passes → tokens refill → requests allowed again
```

Allows **bursting** (using saved-up tokens) — good for APIs with occasional spikes.

---

### 2. Leaking Bucket
Requests enter a queue. Queue drains at a fixed rate regardless of input.

```
Queue (capacity 100)
Drain rate: 10 req/second

Requests pile up → queue fills → overflow = rejected
Process at steady 10/s → no bursting allowed
```

Enforces **strict constant rate** — good for protecting slow backends.

```typescript
// leaking-bucket.ts — the fixed bug
if (level + 1 <= maxRequests) {  // was: level < maxRequests (off by one)
    level++;
    return { allowed: true };
}
```

---

### 3. Fixed Window
Divide time into fixed windows (e.g., 0-60s, 60-120s). Count requests per window.

```
Window: 0s → 60s, max 100 requests
At second 59: 99 requests made
At second 60: window resets → 100 more allowed immediately
```

Simple but has **boundary attack** — 200 requests possible right around window reset.

---

### 4. Sliding Window Log
Keep a log of exact timestamps of recent requests. Count how many fall within last N seconds.

```
Log: [58.1s, 58.7s, 59.2s, 59.8s, ...]
Now = 60s, window = 60s
Count timestamps > 0s → exact count
```

Most accurate but high memory (stores every timestamp).

---

### 5. Sliding Window Counter
Hybrid: two fixed windows, interpolate between them.

```
PreviousWindow count: 80  (60% of which still in our window)
CurrentWindow count: 30
Estimate = 0.6 * 80 + 30 = 78
```

Best balance of accuracy + memory efficiency.

---

## Multi-Dimension Rate Limiting

```typescript
// Different limits per dimension
"rl:ip:192.168.1.1"          → 100 req/min per IP
"rl:route:/api/v1"           → 1000 req/min per route
"rl:api-key:sk-abc123"       → 500 req/min per API key
"rl:header:x-tenant:tenant1" → custom per-tenant limit
```

Each dimension is evaluated **independently**. A request can be blocked by any dimension.

---

## Distributed Rate Limiting with Redis + Lua

For multiple proxy instances, in-memory counters don't work (each instance has separate memory). Solution: store counter in Redis, use Lua scripts for atomic increment:

```lua
-- Atomic: no race conditions possible
local current = redis.call('INCR', key)
if current == 1 then
    redis.call('EXPIRE', key, windowSeconds)
end
if current > maxRequests then
    return 0  -- rejected
end
return 1  -- allowed
```

Lua scripts run atomically on Redis server — no two proxy instances can race.

---

## Soft Limit + Burst Policy

```typescript
// When system load is low, temporarily increase limit by 1.5x
const effectiveLimit = systemLoad < softThreshold
    ? maxRequests * 1.5  // burst allowed
    : maxRequests;        // strict limit
```

---