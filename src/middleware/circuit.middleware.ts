import type { RequestContext } from '../core/pipeline/context.js';

export function circuitMiddleware(isOpen: () => boolean) {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    if (isOpen()) {
      ctx.res.writeHead(503, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({ error: 'Circuit Open' }));
      return;
    }
    await next();
  };
}
