# 🔄 Event-Driven Cache Invalidation via Debezium CDC

## Overview
Standard TTL-based caching creates an unavoidable trade-off:
- Short TTLs (e.g. 5s) reduce stale data risk but increase database load and cache miss rates.
- Long TTLs (e.g. 10m) optimize performance but serve stale reads after database writes.

Ninja Reverse Proxy solves this using **Change Data Capture (CDC)**. By receiving real-time transaction log events from the database via **Debezium**, the proxy invalidates cached HTTP routes within milliseconds of a SQL `UPDATE`, `INSERT`, or `DELETE`.

CDC events reach the proxy through an **admin-gated HTTP webhook** — `POST /__cdc/webhook` — not through Redis pub/sub. An earlier version subscribed to a Redis pub/sub channel directly; that was removed because pub/sub has no replay or acknowledgment, so any event published while the cache's Redis client was mid-reconnect was silently dropped forever. A webhook at least gives the sender (a Debezium HTTP sink, or a small bridge process consuming a Kafka topic and re-POSTing each event) a response it can retry on.

```
┌─────────────────┐       ┌─────────────────┐       ┌──────────────────┐
│ PostgreSQL /    │       │ Debezium Server │       │ Debezium HTTP    │
│ MySQL WAL Log   │──────►│ (Kafka Connect) │──────►│ Sink / Kafka     │
└─────────────────┘       └─────────────────┘       │ consumer bridge  │
                                                     └────────┬─────────┘
                                                             │
                                               POST /__cdc/webhook
                                               (x-admin-token, CDC JSON body)
                                                             ▼
                                                    ┌──────────────────┐
                                                    │ Worker that      │
                                                    │ received the     │
                                                    │ HTTP request     │
                                                    └────────┬─────────┘
                                                             │
                                          1. cache.handleDebeziumEvent(body)
                                             — purges this worker's own L1
                                               and the shared L2/Redis entry
                                          2. broadcastCdcInvalidate(body)
                                             — master fans the same event out
                                               to every OTHER worker, each of
                                               which purges its own L1 too
                                                             ▼
                                                    ┌──────────────────┐
                                                    │ 202 Accepted     │
                                                    │ { invalidated: N }│
                                                    └──────────────────┘
```

Every worker process keeps its own in-process L1 cache (`HybridCache`'s `InMemoryLRU`), on top of the shared L2 (Redis). A webhook request lands on exactly one worker — without the broadcast step above, every *other* worker would keep serving its own stale L1 entry forever, invisible to whichever worker actually received the HTTP call. See `src/core/cluster/master.ts`'s `broadcastCdcInvalidate()` and the `CDC_INVALIDATE_L1_REQUEST` / `CDC_INVALIDATE_BROADCAST_REQUEST` IPC messages in `src/core/cluster/worker.ts` for the fan-out mechanism.

The webhook is idempotent: posting the identical event twice in a row invalidates nothing the second time (`{ "invalidated": 0 }`) rather than erroring.

---

## 1. Debezium Event Structure

When a database row changes, Debezium emits an envelope containing the before/after state and operation type:

```json
{
  "op": "u",
  "source": { "table": "orders", "db": "production" },
  "before": { "id": 55, "status": "PENDING" },
  "after":  { "id": 55, "status": "SHIPPED" }
}
```

* Operation codes:
  * `c` (Create / INSERT)
  * `u` (Update / UPDATE)
  * `d` (Delete / DELETE)
  * `r` (Snapshot Read)

---

## 2. The Webhook (`POST /__cdc/webhook`)

Gated the same way as every other `/__*` admin endpoint: a `x-admin-token` header (or `Authorization: Bearer <token>`) matching `admin.token` / `ADMIN_SECRET`, enforced by `src/core/admin/admin.handler.ts`. Request body is the raw Debezium event JSON (see §1); response is `202 Accepted` with `{ "invalidated": <count> }`, where `count` is the total number of cache keys removed across every worker's L1 plus the shared L2/Redis entry.

```bash
curl -X POST http://localhost:8080/__cdc/webhook \
  -H "x-admin-token: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"op":"u","source":{"table":"orders"},"before":{"id":55},"after":{"id":55}}'
# -> 202 {"invalidated":3}
```

## 3. Invalidator Engine (`src/cache/invalidation/debezium.invalidator.ts`)

`DebeziumInvalidator.handle()` registers table-to-path mappings, evaluates the incoming event against them, and returns the number of keys invalidated (summed if more than one mapping matches the table):

```typescript
export class DebeziumInvalidator {
  constructor(
    private mappings: DebeziumMapping[],
    private invalidateFn: (pattern: string) => Promise<number>,
  ) {}

  async handle(eventJson: string): Promise<number> {
    const event = JSON.parse(eventJson);
    if (event.op && !["c", "u", "d", "r"].includes(event.op)) return 0;
    const tableName = event.source?.table ?? event.source?.collection ?? "";
    if (!tableName) return 0;

    const recordId = /* extracted from before/after/patch — handles {"$oid": "..."} too */;
    if (!recordId) return 0;

    const matched = this.mappings.filter((m) => m.table === tableName);
    let total = 0;
    for (const m of matched) {
      total += await this.invalidateFn(m.pathPattern.replace("{id}", recordId));
    }
    return total;
  }
}
```

---

## 4. Supported Invalidation Strategies

| Invalidation Type | Class | Behavior |
|---|---|---|
| **Exact Path Invalidation** | `HybridCache.del()` | Purges exact key: `proxy:GET:/api/orders/55`. |
| **Wildcard Pattern Purge** | `PatternInvalidator` | Purges all related sub-routes: `proxy:GET:/api/orders/*`. |
| **Tag-Based Invalidation** | `TagInvalidator` | Associates keys with entity tags (e.g. `tag:orders:55`) for multi-route purging. |

---

## 5. Operational Edge Cases & Gotchas

1. **MongoDB ObjectID Parsing**: When streaming CDC events from MongoDB, primary keys are nested within `_id: { "$oid": "64b..." }`. The invalidator normalizes nested ID objects into plain string identifiers before substitution.
2. **Out-of-Order Events**: High-concurrency database writes can generate out-of-order CDC messages. Because CDC triggers a cache *eviction* (`DEL`) rather than a cache *mutation*, subsequent reads always re-query the primary database, guaranteeing eventual consistency.
3. **Cluster fan-out has a timeout**: `broadcastCdcInvalidate()` waits up to 2s for every other worker to acknowledge before the webhook responds. A worker that doesn't reply in time (crashed, overloaded) is simply excluded from the reported `invalidated` count — its own L1 entry would then expire on its normal TTL instead of being purged immediately.
4. **No L2, no convergence**: if Redis is down or not configured, L1 is not shared across workers at all — each worker independently re-fetches from the real upstream on its own first touch after invalidation. That's still correct (no worker serves stale data), but different workers can briefly report different "freshly fetched" values until each has made its own round-trip.
