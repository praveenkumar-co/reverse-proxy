import type { RequestContext } from '../core/pipeline/context.js';
import type { Cache } from '../cache/cache-manager.js';

export function cacheMiddleware(cache: Cache) {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    if (ctx.req.method === 'GET') {
      const url = new URL(ctx.req.url!, `http://${ctx.req.headers.host}`);
      const key = cache.buildKey('GET', url.pathname);
      const cached = await cache.get(key);
      if (cached) {
        ctx.res.writeHead(200, { 'X-Cache': 'HIT' });
        ctx.res.end(cached);
        return;
      }
    }
    await next();
  };
}
