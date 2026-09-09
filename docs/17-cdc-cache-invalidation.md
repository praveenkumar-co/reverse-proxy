# 🔄 Event-Driven Cache Invalidation via Debezium CDC

## Overview
Standard TTL-based caching creates an unavoidable trade-off:
- Short TTLs (e.g. 5s) reduce stale data risk but increase database load and cache miss rates.
- Long TTLs (e.g. 10m) optimize performance but serve stale reads after database writes.

Ninja Reverse Proxy solves this using **Change Data Capture (CDC)**. By streaming real-time transaction log events from the database via **Debezium**, the proxy invalidates cached HTTP routes within milliseconds of a SQL `UPDATE`, `INSERT`, or `DELETE`.

```
┌─────────────────┐       ┌─────────────────┐       ┌──────────────────┐
│ PostgreSQL /    │       │ Debezium Server │       │ Redis Pub/Sub /  │
│ MySQL WAL Log   │──────►│ (Kafka Connect) │──────►│ Kafka Topic      │
└─────────────────┘       └─────────────────┘       └────────┬─────────┘
                                                             │
                                                      CDC JSON Event
                                                             ▼
                                                    ┌──────────────────┐
                                                    │ Reverse Proxy    │
                                                    │ Debezium         │
                                                    │ Invalidator      │
                                                    └────────┬─────────┘
                                                             │
                                                    Extract PK & Purge
                                                             ▼
                                                    ┌──────────────────┐
                                                    │ L1 / L2 Cache    │
                                                    │ DEL /api/users/55│
                                                    └──────────────────┘
```

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

## 2. Invalidator Engine (`src/cache/invalidation/debezium.invalidator.ts`)

The `DebeziumInvalidator` registers table-to-path mappings and evaluates incoming events against cache key patterns:

```typescript
export interface TableMapping {
  table: string;
  pathPattern: string; // e.g. "/api/orders/{id}"
}

export class DebeziumInvalidator {
  constructor(
    private readonly mappings: TableMapping[],
    private readonly onInvalidate: (path: string) => Promise<void>
  ) {}

  async handle(rawEvent: string): Promise<void> {
    const payload = JSON.parse(rawEvent);
    const table = payload.source?.table;
    const op = payload.op;
    if (!['c', 'u', 'd'].includes(op)) return;

    const rowData = payload.after || payload.before;
    if (!rowData) return;

    for (const mapping of this.mappings) {
      if (mapping.table === table) {
        // Substitute primary key placeholders: {id} -> 55
        let targetPath = mapping.pathPattern;
        for (const [col, val] of Object.entries(rowData)) {
          targetPath = targetPath.replace(`{${col}}`, String(val));
        }
        await this.onInvalidate(targetPath);
      }
    }
  }
}
```

---

## 3. Supported Invalidation Strategies

| Invalidation Type | Class | Behavior |
|---|---|---|
| **Exact Path Invalidation** | `HybridCache.del()` | Purges exact key: `proxy:GET:/api/orders/55`. |
| **Wildcard Pattern Purge** | `PatternInvalidator` | Purges all related sub-routes: `proxy:GET:/api/orders/*`. |
| **Tag-Based Invalidation** | `TagInvalidator` | Associates keys with entity tags (e.g. `tag:orders:55`) for multi-route purging. |

---

## 4. Operational Edge Cases & Gotchas

1. **MongoDB ObjectID Parsing**: When streaming CDC events from MongoDB, primary keys are nested within `_id: { "$oid": "64b..." }`. The invalidator normalizes nested ID objects into plain string identifiers before substitution.
2. **Out-of-Order Events**: High-concurrency database writes can generate out-of-order CDC messages. Because CDC triggers a cache *eviction* (`DEL`) rather than a cache *mutation*, subsequent reads always re-query the primary database, guaranteeing eventual consistency.
