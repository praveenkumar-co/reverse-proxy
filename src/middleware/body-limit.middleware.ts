import type { RequestContext } from '../core/pipeline/context.js';

export function bodyLimitMiddleware(maxBytes: number) {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const contentLength = parseInt(ctx.req.headers['content-length'] ?? '0', 10);
    if (contentLength > maxBytes) {
      ctx.res.writeHead(413, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({ error: 'Payload Too Large' }));
      return;
    }
    await next();
  };
}
