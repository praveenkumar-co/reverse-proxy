# 🧭 Distributed Tracing & Correlation Headers

## Overview
In distributed microservice architectures, an error or high latency observed by an edge proxy often originates deep within downstream dependencies. Without correlation IDs, isolating logs across services is nearly impossible.

Ninja Reverse Proxy embeds an in-process **Distributed Tracer (`Tracer`)** that assigns a globally unique `traceId` to every transaction, records microsecond-precision span durations, and injects tracing metadata into both upstream requests and downstream client responses.

```
Browser / Client
      │
      │ HTTP GET /api/orders
      ▼
┌─────────────────────────────────────────────────────────┐
│ NINJA REVERSE PROXY (Master/Worker)                     │
│                                                         │
│ 1. Extract or Generate traceId: 8aac06d2-db58...        │
│ 2. Tracer.startSpan("http_proxy_request", traceId)      │
│ 3. Forward request with header:                         │
│    X-Trace-Id: 8aac06d2-db58-416e-b551-daa489bf77bb    │
└───────────────────────────┬─────────────────────────────┘
                            │
                            │ Upstream Request
                            ▼
┌─────────────────────────────────────────────────────────┐
│ UPSTREAM MICROSERVICE (e.g. Chess Node / Order Service) │
│                                                         │
│ 1. Reads X-Trace-Id from request headers                │
│ 2. Emits log: "[8aac06d2...] Database query executed"   │
│ 3. Responds to proxy                                    │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│ NINJA REVERSE PROXY                                     │
│                                                         │
│ 1. Tracer.endSpan(span)                                 │
│ 2. Inject Response Header:                              │
│    X-Trace-Id: 8aac06d2-db58-416e-b551-daa489bf77bb    │
│ 3. Emit structured access log correlated with traceId   │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Tracer Architecture (`src/observability/tracing/tracer.ts`)

```typescript
export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs?: number;
  attributes: Record<string, unknown>;
}

export class Tracer {
  private spans: Span[] = [];

  startSpan(name: string, traceId: string, attributes: Record<string, unknown> = {}): Span {
    const span: Span = {
      traceId,
      spanId: crypto.randomUUID(),
      name,
      startMs: performance.now(),
      attributes,
    };
    this.spans.push(span);
    return span;
  }

  endSpan(span: Span): void {
    span.endMs = performance.now();
  }

  flush(): Span[] {
    const drained = this.spans;
    this.spans = [];
    return drained;
  }
}

export const tracer = new Tracer();
```

---

## 2. Injected & Propagated Headers

| Header | Source | Purpose |
|---|---|---|
| `X-Trace-Id` | Generated UUIDv4 or propagated from incoming request | Universal correlation identifier across all proxy logs and upstream traces. |
| `X-Upstream-Id` | Selected backend instance (e.g. `chess-backend-1`) | Explicitly attributes which backend handled the request. |
| `X-Forwarded-For` | Client remote socket IP (or appended XFF chain) | Preserves client IP across multi-hop proxy topologies. |
| `X-Forwarded-Proto` | `https` or `http` | Signals upstream if TLS was terminated at proxy edge. |
| `X-Forwarded-Host` | Original `Host` header | Preserves canonical domain requested by client. |

---

## 3. Log Correlation Example

Because `traceId` is attached to the request context, structured logs from the proxy and backend match directly:

```json
{"timestamp":"2026-09-09T07:22:16.800Z","level":"info","traceId":"8aac06d2-db58-416e-b551-daa489bf77bb","component":"ProxyForward","upstream":"chess-backend-2","status":200,"latencyMs":2.28}
```

---

## 4. Operational Edge Cases & Gotchas

1. **Untrusted Client Headers**: If a malicious client passes an arbitrary `X-Trace-Id`, it can pollute logging systems. In untrusted edge environments, incoming trace IDs should be sanitized or overwritten unless coming from trusted VPC CIDRs.
2. **Buffer Flushing in Worker Threads**: Spans stored in worker memory are flushed on intervals or request lifecycle completion to prevent unbounded memory growth during high-throughput soak periods.
