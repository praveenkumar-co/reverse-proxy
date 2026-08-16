import type { RequestContext } from '../core/pipeline/context.js';
import type { RateLimiter } from '../ratelimit/rate-limiter.js';

export function rateLimitMiddleware(limiter: RateLimiter) {
  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const allowed = await limiter.isAllowed(ctx.clientIp);
    if (!allowed) {
      ctx.res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
        'X-RateLimit-Limit': String(limiter['maxRequests']),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(limiter.getResetTime(ctx.clientIp)),
        'X-RateLimit-Algorithm': limiter.getAlgorithm(),
      });
      ctx.res.end(JSON.stringify({ error: 'Too Many Requests' }));
      return;
    }
    await next();
  };
}
