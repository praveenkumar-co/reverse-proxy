import type http from 'http';
import type net from 'net';

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  clientIp: string;
  startTime: number;
  upstreamId?: string;
  routePath?: string;
  metadata: Record<string, unknown>;
}

export interface TrustProxyOptions {
  trustProxy?: boolean | undefined;
  trustedProxies?: string[] | undefined;
}

function normalizeAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '').trim();
}

export function resolveClientIp(
  req: http.IncomingMessage,
  socket: net.Socket | undefined,
  options: TrustProxyOptions = {},
): string {
  const remoteAddress = normalizeAddress(socket?.remoteAddress ?? req.socket?.remoteAddress);
  // Matches server.schema.ts's `trustProxy` default (true) when the caller doesn't pass
  // an explicit value — only an explicit `false` stops X-Forwarded-For from being honored.
  const trustProxy = options.trustProxy ?? true;
  const isTrustedPeer =
    trustProxy ||
    (options.trustedProxies?.some((p) => normalizeAddress(p) === remoteAddress) ?? false);

  if (isTrustedPeer) {
    const xff = req.headers['x-forwarded-for'];
    const xffValue = Array.isArray(xff) ? xff[0] : xff;
    const first = xffValue?.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress || 'unknown';
}

export function createContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  trustProxyOptions?: TrustProxyOptions,
): RequestContext {
  return {
    req,
    res,
    clientIp: resolveClientIp(req, req.socket, trustProxyOptions),
    startTime: performance.now(),
    metadata: {},
  };
}
