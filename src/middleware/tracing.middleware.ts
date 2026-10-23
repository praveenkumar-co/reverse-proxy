import type { RequestContext } from '../core/pipeline/context.js';
import { tracer } from '../observability/tracing/tracer.js';
import {
  generateTraceId,
  generateSpanId,
  parseTraceParent,
  buildTraceParent,
} from '../observability/tracing/w3c-trace-context.js';

export function tracingMiddleware(){
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const incoming = parseTraceParent(ctx.req.headers['traceparent'] as string | undefined);
    const traceId = incoming?.traceId ?? (ctx.req.headers['x-trace-id'] as string) ?? generateTraceId();
    const spanId = generateSpanId();
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
