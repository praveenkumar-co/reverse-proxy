# ⚡ Multi-Tier Caching Architecture (L1 RAM + L2 Distributed)

## Overview
A single-tier in-memory cache suffers from cold-start memory duplication across workers and cluster nodes, while a centralized cache (like Redis) incurs network latency (0.5–2ms per query).

Ninja Reverse Proxy implements a **Hybrid Two-Tier Cache (`HybridCache`)**:
* **L1 Cache (In-Memory LRU)**: Sub-millisecond reads (<0.05ms) local to each worker process.
* **L2 Cache (Distributed Redis)**: Cluster-shared persistence that prevents cache misses when new worker nodes spawn.

```
Request GET /api/users
        │
        ▼
┌───────────────────────────────────────┐
│ L1 In-Memory LRU Cache                │
│ (Worker Local RAM - Sub-millisecond)  │
└──────────────────┬────────────────────┘
                   │
           HIT ────┴──── MISS
            │             │
            ▼             ▼
    Return Payload ┌────────────────────────────────────┐
    (0.02ms latency)│ L2 Distributed Redis Cache         │
                   └──────────────┬─────────────────────┘
                                  │
                          HIT ────┴──── MISS
                           │             │
                           ▼             ▼
                   Warms L1 Cache   Fetch Upstream Backend
                   & Returns Data   Warms L1 + L2 Simultaneously
```

---

## 1. L1 In-Memory LRU Cache (`src/cache/stores/in-memory-lru.ts`)

- **Synchronous Execution**: Eliminates asynchronous event loop scheduling delays for hot data.
- **Strict Bounded Memory**: Enforces `maxSize` entries with Least-Recently-Used eviction via JavaScript `Map` insertion ordering.
- **Negative TTL Protection**: Expired entries return `null` immediately upon lookup and are removed lazily.
- **Pattern Invalidation**: Supports wildcard pattern purging (`users:*`).

```typescript
export class InMemoryLRU implements ICache {
  get(key: string): string | null;
  set(key: string, value: string, ttlSeconds?: number): void;
  del(key: string): void;
  invalidatePattern(pattern: string): void;
  getStats(): { size: number; maxSize: number };
}
```

---

## 2. Hybrid Two-Tier Cache (`src/cache/stores/hybrid.cache.ts`)

`HybridCache` orchestrates L1 and L2 operations with write-through semantics and graceful degradation:

```typescript
export class HybridCache implements ICache {
  constructor(
    private readonly l2: ICache,
    private readonly l1MaxSize = 1000,
    private readonly defaultTtl = 60
  ) {
    this.l1 = new InMemoryLRU(l1MaxSize);
  }

  async get(key: string): Promise<string | null> {
    // 1. Check L1 Fast Path (Sync Memory)
    const l1Hit = this.l1.get(key);
    if (l1Hit !== null) return l1Hit;

    // 2. Check L2 Distributed Store
    try {
      const l2Hit = await this.l2.get(key);
      if (l2Hit !== null) {
        // Backfill L1 to accelerate subsequent requests
        this.l1.set(key, l2Hit, this.defaultTtl);
        return l2Hit;
      }
    } catch {
      // Graceful degradation: Redis failure does not crash the proxy
    }
    return null;
  }

  async set(key: string, val: string, ttl?: number): Promise<void> {
    this.l1.set(key, val, ttl ?? this.defaultTtl);
    try {
      await this.l2.set(key, val, ttl ?? this.defaultTtl);
    } catch {}
  }
}
```

---

## 3. Cache Key Generation (`src/cache/policies/key-builder.ts`)

Cache collisions occur when requests with different query parameters, authentication states, or compression headers share the same raw path. `KeyBuilder` generates deterministic canonical keys:

```text
proxy:GET:/api/catalog?category=electronics:Accept-Encoding=gzip
```

Features:
- Encodes HTTP Method + Normalized Path.
- Encodes query parameters in canonical order.
- Respects HTTP `Vary` headers (e.g. `Accept-Encoding`, `Accept-Language`).
- Configurable ignored query parameters (e.g. `utm_source`, `timestamp`).

---

## 4. Stale Policies

### Stale-While-Revalidate (SWR)
Allows returning stale cached content to the client instantly while triggering an asynchronous background fetch to refresh the upstream payload. Eliminates latency spikes on cache expiry.

### Stale-If-Error
If the upstream backend returns a `500 Internal Server Error`, `502 Bad Gateway`, or network connection timeout, the proxy checks if an expired cache entry exists within the `stale-if-error` grace window. If present, it serves the stale payload instead of surfacing an outage to the user.

---

## Configuration (`proxy.yaml`)

```yaml
cache:
  enabled: true
  storage: hybrid             # memory | redis | hybrid
  ttlSeconds: 120
  maxSizeMb: 128
  redis:
    host: "127.0.0.1"
    port: 6379
  staleWhileRevalidate: 30
  staleIfError: 300
```
