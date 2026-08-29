import type { RequestContext } from '../core/pipeline/context.js';

export function authMiddleware(validTokens: Set<string>){
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const authHeader = ctx.req.headers['authorization'];
    if (validTokens.size > 0){
      const token = authHeader?.replace('Bearer ', '');
      if (!token || !validTokens.has(token)){
        ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
    await next();
  };
}
