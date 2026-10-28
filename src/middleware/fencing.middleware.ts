import type { RequestContext } from '../core/pipeline/context.js';

export interface FencingOptions {
  headerName?: string;
  rejectStatus?: number;
  methods?: string[];
  requireToken?: boolean;
  getResourceKey?: (ctx: RequestContext) => string;
  initialEpoch?: number;
}

export class FencingTokenTracker {
  private epochs = new Map<string, number>();

  constructor(private defaultInitialEpoch: number = 0) {}

  getCurrentEpoch(resourceKey = 'global'): number {
    return this.epochs.get(resourceKey) ?? this.defaultInitialEpoch;
  }

  setEpoch(epoch: number, resourceKey = 'global'): void {
    const current = this.getCurrentEpoch(resourceKey);
    if (epoch > current) {
      this.epochs.set(resourceKey, epoch);
    }
  }

  validateAndAdvance(token: number, resourceKey = 'global'): { valid: boolean; currentEpoch: number } {
    const current = this.getCurrentEpoch(resourceKey);
    if (token < current) {
      return { valid: false, currentEpoch: current };
    }
    if (token > current) {
      this.epochs.set(resourceKey, token);
    }
    return { valid: true, currentEpoch: Math.max(current, token) };
  }

  reset(): void {
    this.epochs.clear();
  }
}

export function fencingMiddleware(
  options: FencingOptions = {},
  tracker: FencingTokenTracker = new FencingTokenTracker(options.initialEpoch ?? 0)
) {
  const headerName = (options.headerName ?? 'x-fencing-token').toLowerCase();
  const rejectStatus = options.rejectStatus ?? 409;
  const guardedMethods = new Set((options.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).map((m) => m.toUpperCase()));
  const requireToken = options.requireToken ?? false;
  const getResourceKey = options.getResourceKey ?? (() => 'global');

  const mw = async (ctx: RequestContext, next: () => Promise<void>) => {
    const method = (ctx.req.method ?? 'GET').toUpperCase();
    if (!guardedMethods.has(method)) {
      return next();
    }

    const rawToken = ctx.req.headers[headerName];
    const resourceKey = getResourceKey(ctx);

    if (rawToken === undefined || rawToken === null || rawToken === '') {
      if (requireToken) {
        ctx.res.writeHead(428, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify({
          error: 'Precondition Required: Missing Fencing Token',
          header: headerName,
        }));
        return;
      }
      return next();
    }

    const tokenValue = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const parsedToken = Number.parseInt(tokenValue ?? '', 10);

    if (Number.isNaN(parsedToken) || parsedToken < 0) {
      ctx.res.writeHead(400, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({
        error: 'Bad Request: Invalid Fencing Token (must be a positive integer)',
        received: tokenValue,
      }));
      return;
    }

    const check = tracker.validateAndAdvance(parsedToken, resourceKey);
    if (!check.valid) {
      ctx.res.writeHead(rejectStatus, {
        'Content-Type': 'application/json',
        'X-Current-Epoch': check.currentEpoch.toString(),
      });
      ctx.res.end(JSON.stringify({
        error: 'Stale Fencing Token: Zombie Leader Write Rejected',
        currentEpoch: check.currentEpoch,
        providedEpoch: parsedToken,
        resource: resourceKey,
      }));
      return;
    }

    ctx.metadata.fencingEpoch = check.currentEpoch;
    await next();
  };

  mw.tracker = tracker;
  return mw;
}
