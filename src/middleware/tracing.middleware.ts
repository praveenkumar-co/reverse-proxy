import type { RequestContext } from '../core/pipeline/context.js';
import crypto from 'node:crypto';
import { tracer } from '../observability/tracing/tracer.js';

export function tracingMiddleware() {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const traceId = (ctx.req.headers['x-trace-id'] as string) ?? crypto.randomUUID();
    ctx.metadata['traceId'] = traceId;
    ctx.res.setHeader('X-Trace-Id', traceId);

    const span = tracer.startSpan(
      `${ctx.req.method ?? 'GET'} ${ctx.req.url ?? '/'}`,
      traceId,
      { ip: ctx.clientIp ?? '', path: (ctx.metadata['routePath'] as string) ?? '' }
    );
    ctx.metadata['span'] = span;

    try {
      await next();
    } finally {
      tracer.endSpan(span);
    }
  };
}
