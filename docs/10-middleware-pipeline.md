# 🔗 Middleware Pipeline — How It Works

## What Is the Middleware Pipeline?

Every HTTP request passes through an ordered chain of middleware functions before reaching the backend. Each middleware can:
- Modify the request/response
- Short-circuit (reject early with error)
- Call `next()` to pass to the next middleware

Same pattern as Express/Koa — called the **Onion Model**.

---

## The Pipeline Order

```
Incoming Request
       │
  1. CORS          ← Add Access-Control headers
       │
  2. Body Limit    ← Reject oversized request bodies
       │
  3. Auth          ← Verify JWT / API key
       │
  4. Rate Limit    ← Check request count per window
       │
  5. Cache         ← Return cached response if exists
       │
  6. Circuit Breaker ← Check if upstream is healthy
       │
  7. Bulkhead      ← Check concurrency slots
       │
  8. Proxy         ← Forward to backend, get response
       │
  Response flows back UP through each middleware
```

---

## How next() Works

```typescript
// Each middleware signature
type Middleware = (ctx: RequestContext, next: () => Promise<void>) => Promise<void>;

// Example: Rate Limit middleware
async function rateLimitMiddleware(ctx, next) {
    const result = await rateLimiter.check(ctx.clientIP);
    if (!result.allowed) {
        ctx.res.writeHead(429, { 'Retry-After': result.retryAfter });
        ctx.res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return; // short-circuit — next() NOT called
    }
    await next(); // pass to next middleware
}

// Example: Cache middleware
async function cacheMiddleware(ctx, next) {
    const cached = await cache.get(ctx.cacheKey);
    if (cached) {
        ctx.res.writeHead(200, cached.headers);
        ctx.res.end(cached.body);
        return; // short-circuit — backend never called
    }
    await next(); // go to backend
    await cache.set(ctx.cacheKey, ctx.response); // cache the response on the way back
}
```

---

## RequestContext — Shared State

```typescript
interface RequestContext {
    req: http.IncomingMessage;   // original request
    res: http.ServerResponse;    // response to write to
    clientIP: string;            // extracted client IP
    upstreamId: string;          // chosen upstream
    upstreamUrl: string;         // full upstream URL
    cacheKey: string;            // normalized cache key
    startTime: number;           // for latency measurement
    traceId: string;             // for distributed tracing
    response?: ProxyResponse;    // set by proxy middleware
}
```

All middleware share this single context object. Middleware reads from and writes to it as the request flows through.

---

## Pipeline Execution

```typescript
// MiddlewarePipeline.ts
class MiddlewarePipeline {
    private middlewares: Middleware[] = [];

    use(middleware: Middleware) {
        this.middlewares.push(middleware);
    }

    async execute(ctx: RequestContext) {
        let index = 0;
        const next = async () => {
            if (index < this.middlewares.length) {
                const middleware = this.middlewares[index++];
                await middleware(ctx, next);
            }
        };
        await next();
    }
}

// Setup in worker.ts
const pipeline = new MiddlewarePipeline();
pipeline.use(corsMiddleware);
pipeline.use(bodyLimitMiddleware);
pipeline.use(authMiddleware);
pipeline.use(rateLimitMiddleware);
pipeline.use(cacheMiddleware);
pipeline.use(circuitBreakerMiddleware);
pipeline.use(bulkheadMiddleware);
pipeline.use(proxyMiddleware); // last — actually forwards to backend
```

---
