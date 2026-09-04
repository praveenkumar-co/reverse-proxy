# 💾 Multi-Tier Caching — How It Works

## What Is Caching in a Proxy?

Instead of forwarding every request to the backend, the proxy stores responses and serves them directly. This:
- Reduces backend load dramatically
- Cuts response time from ~50ms to <1ms (memory hit)
- Protects backends during traffic spikes

---

## Two-Tier Architecture

```
Request
   ↓
L1 Cache (In-Process Memory — LRU)
   │ HIT → return instantly (<1ms)
   │ MISS ↓
L2 Cache (Redis — Shared across all proxy workers)
   │ HIT → warm L1, return (~2ms)
   │ MISS ↓
Backend (real server)
   │ → store in both L2 (Redis) and L1 (Memory)
   ↓
Return to client
```

---

## L1 — In-Memory LRU Cache

Each worker process has its own LRU (Least Recently Used) cache:

```typescript
// LRU eviction: when full, evict least-recently-used entry
class LRUCache {
    get(key) {
        // Move to front (most recently used)
        const entry = map.get(key);
        list.moveToFront(entry);
        return entry.value;
    }
    set(key, value) {
        if (size >= maxSize) {
            list.removeTail(); // evict least recently used
        }
        // ...
    }
}
```

**Why per-worker?** Workers are separate processes. Sharing memory across processes requires IPC which is slow. Better to give each worker its own fast local cache and use Redis for cross-worker sharing.

---

## L2 — Redis Distributed Cache

Shared across ALL workers and proxy instances:

```typescript
// cache.middleware.ts
async function getCached(key) {
    // Check L1 first
    const l1Hit = memoryCache.get(key);
    if (l1Hit) return l1Hit;

    // Check L2
    const l2Hit = await redis.get(key);
    if (l2Hit) {
        memoryCache.set(key, l2Hit); // warm L1
        return l2Hit;
    }
    return null;
}
```

---

## Cache Key Normalization

```typescript
// KeyBuilder — strips tracking params that don't affect content
// utm_source=google&utm_medium=email → stripped
// fbclid=abc → stripped

// /api/products?color=red&utm_source=google
// → cache key: /api/products?color=red

// Also handles Vary headers:
// Accept-Encoding: gzip → separate cache entry per encoding
```

---

## stale-while-revalidate — Prevents Cache Stampedes

```
Normal cache:
  T=0:  cache MISS → fetch backend → store
  T=60: cache EXPIRES → 100 concurrent requests all MISS → 100 fetches hit backend simultaneously (stampede!)

stale-while-revalidate:
  T=60: cache EXPIRED → first request serves stale data + triggers 1 background refresh
        other 99 requests also serve stale data immediately
  T=60.1: background fetch completes → cache updated
  → Backend got exactly 1 request, not 100
```

```typescript
if (isStale && !revalidating[key]) {
    revalidating[key] = true; // lock — only ONE background refresh
    fetchAndUpdate(key).finally(() => delete revalidating[key]);
}
return staleData; // serve immediately while refreshing
```

---

## stale-if-error — Serves During Outages

```typescript
try {
    const response = await proxyToBackend(req);
    await cache.set(key, response);
    return response;
} catch (err) {
    // Backend is down — serve stale cache instead of 502
    const stale = await cache.getStale(key);
    if (stale) return stale;
    throw err; // no stale → 502
}
```

---

## Debezium CDC Cache Invalidation

When a database record changes, relevant cache entries must be invalidated:

```
Database UPDATE orders SET status='shipped' WHERE id=999
   ↓
Debezium captures the change from transaction log
   ↓
Publishes to Redis Pub/Sub:
  {"op":"u", "source":{"table":"orders"}, "after":{"id":999}}
   ↓
Proxy subscribes to Redis Pub/Sub channel
   ↓
Maps table+id → cache path: "/api/orders/999"
   ↓
Deletes cache entry for /api/orders/999
   ↓
Next request gets fresh data from backend
```

---