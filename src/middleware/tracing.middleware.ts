import type { RequestContext } from '../core/pipeline/context.js';
import { tracer } from '../observability/tracing/tracer.js';
import {
  generateSpanId,
  generateTraceAndSpanId,
  parseTraceParent,
  buildTraceParent,
} from '../observability/tracing/w3c-trace-context.js';

export function tracingMiddleware(){
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const incoming = parseTraceParent(ctx.req.headers['traceparent'] as string | undefined);
    const existingTraceId = incoming?.traceId ?? (ctx.req.headers['x-trace-id'] as string | undefined);
    // The common case for a proxy acting as the entry point — no incoming trace context at
    // all — needs both a fresh trace id and span id; generateTraceAndSpanId() mints both from
    // one crypto.randomBytes() call instead of two. A request that already carries a trace id
    // only needs a new span id for this hop.
    let traceId: string;
    let spanId: string;
    if (existingTraceId) {
      traceId = existingTraceId;
      spanId = generateSpanId();
    } else {
      ({ traceId, spanId } = generateTraceAndSpanId());
    }
    const flags = incoming?.flags ?? '01';
    // Per the W3C spec, each hop forwards traceparent with parent-id replaced by its own
    // span id — mutating the request header here is what makes worker.ts's "forward every
    // incoming header" behavior propagate this correctly to the upstream.
    const traceparentHeader = buildTraceParent(traceId, spanId, flags);

    ctx.metadata['traceId'] = traceId;
    ctx.metadata['spanId'] = spanId;
    ctx.req.headers['x-trace-id'] = traceId;
    ctx.req.headers['traceparent'] = traceparentHeader;
    ctx.res.setHeader('traceparent', traceparentHeader);
    ctx.res.setHeader('X-Trace-Id', traceId);

    const span = tracer.startSpan(
      `${ctx.req.method ?? 'GET'} ${ctx.req.url ?? '/'}`,
      traceId,
      { ip: ctx.clientIp ?? '', path: (ctx.metadata['routePath'] as string) ?? '' },
      spanId,
    );
    ctx.metadata['span'] = span;

    try {
      await next();
    } finally {
      tracer.endSpan(span);
    }
  };
}
