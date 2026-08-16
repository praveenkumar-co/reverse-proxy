import type { RequestContext } from '../core/pipeline/context.js';
import { logger } from '../observability/logger/logger.js';

export function loggingMiddleware() {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    await next();
    const latency = performance.now() - ctx.startTime;
    logger.info('Request', `${ctx.req.method} ${ctx.req.url} ${ctx.res.statusCode} ${latency.toFixed(1)}ms`);
  };
}
