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
  // Matches server.schema.ts's `trustProxy` default (false) when the caller doesn't pass an
  // explicit value. X-Forwarded-For is only ever honored from a peer that is both
  // trustProxy-enabled AND explicitly listed in trustedProxies — never a blanket "trust
  // everyone" mode, since that would let any direct client set its own X-Forwarded-For and
  // pick whatever IP it likes, bypassing per-IP rate limiting entirely.
  const trustProxy = options.trustProxy ?? false;
  const trustedProxies = options.trustedProxies ?? [];
  const isTrustedPeer =
    trustProxy && trustedProxies.some((p) => normalizeAddress(p) === remoteAddress);

  if (isTrustedPeer){
    const xff = req.headers['x-forwarded-for'];
    const xffValue = Array.isArray(xff) ? xff[0] : xff;
    if (xffValue){
      const hops = xffValue
        .split(',')
        .map((h) => normalizeAddress(h))
        .filter(Boolean);
      // Walk from the rightmost hop (closest to us) leftward, skipping any hop that is
      // itself a known trusted proxy, and return the first one that isn't. The original
      // client controls everything to the left of where our trusted proxies started
      // appending, so blindly taking the leftmost (first) value — as this used to — lets a
      // client inject any IP it wants by simply setting its own X-Forwarded-For header.
      for (let i = hops.length - 1; i >= 0; i--){
        const hop = hops[i]!;
        const hopIsTrustedProxy = trustedProxies.some((p) => normalizeAddress(p) === hop);
        if (!hopIsTrustedProxy) return hop;
      }
    }
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