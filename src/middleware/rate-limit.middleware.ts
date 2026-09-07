import type { RequestContext } from '../core/pipeline/context.js';
import type { RateLimiter } from '../ratelimit/rate-limiter.js';

export function rateLimitMiddleware(limiter: RateLimiter){
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const allowed = await limiter.isAllowed(ctx.clientIp);

    const limit = limiter['maxRequests'];
    const remaining = await limiter.getRemaining(ctx.clientIp);
    const reset = limiter.getResetTime(ctx.clientIp);
    const algorithm = limiter.getAlgorithm();

    ctx.res.setHeader('X-RateLimit-Limit', String(limit));
    ctx.res.setHeader('X-RateLimit-Remaining', String(remaining));
    ctx.res.setHeader('X-RateLimit-Reset', String(reset));
    ctx.res.setHeader('X-RateLimit-Algorithm', algorithm);

    if(!allowed){
      ctx.res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      ctx.res.end(JSON.stringify({ error: 'Too Many Requests' }));
      return;
    }
    await next();
  };
}
