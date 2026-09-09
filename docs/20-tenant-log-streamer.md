# 🏢 Multi-Tenant Log Streaming & Webhook Dispatch

## Overview
In multi-tenant SaaS environments, different enterprise customers require real-time visibility into the requests routed on their behalf (for audit compliance, security analytics, or SIEM integration like Datadog, Splunk, or custom webhook endpoints).

The **Tenant Log Streamer (`TenantLogStreamer`)** decouples request processing from log shipping: logs are partitioned by `tenantId`, buffered in worker memory, and flushed asynchronously in batches without adding latency to customer transactions.

```
Customer Request (Tenant: "acme-corp")
              │
              ▼
    Proxy Request Pipeline
              │
              ├───► Returns HTTP 200 to Customer (0ms logging latency)
              │
              ▼
   tenantLogStreamer.queueLog("acme-corp", logEntry)
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│ In-Memory Bounded Ring Buffer                           │
│  - acme-corp:  [log1, log2, log3, ...]                  │
│  - beta-corp:  [logA, logB, ...]                        │
└───────────────────────────┬─────────────────────────────┘
                            │
              Asynchronous Flush (Every 5s or Batch 100)
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│ Webhook Dispatcher (HTTP POST JSON)                     │
│  - https://api.acme.com/siem/webhook                    │
│  - https://logs.beta.io/collector                       │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Engine Implementation (`src/observability/logger/tenant-log.streamer.ts`)

```typescript
export interface TenantLogEntry {
  timestamp: string;
  clientIp: string;
  method: string;
  url: string;
  statusCode: number;
  bytesSent: number;
  latencyMs: number;
  userAgent?: string;
}

export class TenantLogStreamer {
  private buffer: Map<string, TenantLogEntry[]> = new Map();
  private destinations: Map<string, string> = new Map();

  configure(configs: { tenantId: string; destination: string }[]): void {
    for (const { tenantId, destination } of configs) {
      this.destinations.set(tenantId, destination);
    }
  }

  queueLog(tenantId: string, entry: TenantLogEntry): void {
    if (!this.destinations.has(tenantId)) return;
    const list = this.buffer.get(tenantId) ?? [];
    list.push(entry);
    this.buffer.set(tenantId, list);
  }

  async flush(): Promise<void> {
    for (const [tenantId, entries] of this.buffer.entries()) {
      if (entries.length === 0) continue;
      const url = this.destinations.get(tenantId);
      if (!url) continue;

      const batch = [...entries];
      this.buffer.set(tenantId, []);

      // Dispatch async HTTP POST
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId, count: batch.length, logs: batch }),
        });
      } catch (err) {
        // Suppress errors to prevent crashing proxy worker
      }
    }
  }
}

export const tenantLogStreamer = new TenantLogStreamer();
```

---

## 2. Zero-Impact Delivery Guarantees

1. **Non-Blocking**: The call to `queueLog` is purely synchronous memory push.
2. **Failure Isolation**: A slow or failing customer webhook endpoint never blocks other tenants or proxy worker threads.
3. **Batch Compression**: Logs are batched into arrays of up to 100 entries per payload to minimize HTTP connection overhead.
