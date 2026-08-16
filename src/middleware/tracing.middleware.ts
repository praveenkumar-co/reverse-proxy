import type { RequestContext } from '../core/pipeline/context.js';
import crypto from 'node:crypto';

export function tracingMiddleware() {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const traceId = (ctx.req.headers['x-trace-id'] as string) ?? crypto.randomUUID();
    ctx.metadata['traceId'] = traceId;
    ctx.res.setHeader('X-Trace-Id', traceId);
    await next();
  };
}
