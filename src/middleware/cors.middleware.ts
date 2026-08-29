import type { RequestContext } from '../core/pipeline/context.js';

export function corsMiddleware(origins: string[] = ['*']){
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const origin = ctx.req.headers['origin'] ?? '*';
    const allowed = origins.includes('*') || origins.includes(origin);
    if (allowed){
      ctx.res.setHeader('Access-Control-Allow-Origin', origin);
      ctx.res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      ctx.res.setHeader('Access-Control-Allow-Headers', '*');
      ctx.res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (ctx.req.method === 'OPTIONS'){
      ctx.res.writeHead(204);
      ctx.res.end();
      return;
    }
    await next();
  };
}
