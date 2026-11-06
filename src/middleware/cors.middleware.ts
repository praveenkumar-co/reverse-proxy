import type { RequestContext } from '../core/pipeline/context.js';

export interface CorsOptions {
  origins?: string[];
  credentials?: boolean;
}

/**
 * Credentials are only ever sent alongside an explicit, matched origin — never a wildcard.
 * Reflecting "*" while also setting Access-Control-Allow-Credentials: true lets any website
 * make a credentialed request (cookies included) and read the response, since the wildcard
 * tells the browser every origin is allowed. A route that wants credentialed CORS must list
 * its allowed origins explicitly; one that doesn't gets plain (non-credentialed) CORS against
 * any origin, which is safe because no cookies/auth are exposed either way.
 */
export function corsMiddleware(options: CorsOptions = {}, onPreflightHandled?: (ctx: RequestContext) => void){
  const explicitOrigins = options.origins && options.origins.length > 0 ? options.origins : undefined;
  const credentialsEnabled = options.credentials === true && explicitOrigins !== undefined;

  return async (ctx: RequestContext, next: () => Promise<void>) => {
    const origin = ctx.req.headers['origin'];
    if (origin){
      const allowed = explicitOrigins ? explicitOrigins.includes(origin) : true;
      if (allowed){
        ctx.res.setHeader('Access-Control-Allow-Origin', explicitOrigins ? origin : '*');
        ctx.res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        ctx.res.setHeader('Access-Control-Allow-Headers', '*');
        if (credentialsEnabled){
          ctx.res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      }
    }
    if (ctx.req.method === 'OPTIONS'){
      ctx.res.writeHead(204);
      ctx.res.end();
      // A preflight response never reaches the rest of the pipeline (no upstream, no
      // dispatch) — without this, it was invisible to both Prometheus and the access log,
      // same class of gap as the rate-limiter's 429s and the "no healthy upstream" 503s.
      onPreflightHandled?.(ctx);
      return;
    }
    await next();
  };
}
