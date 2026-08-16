import type http from 'http';

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  clientIp: string;
  startTime: number;
  upstreamId?: string;
  routePath?: string;
  metadata: Record<string, unknown>;
}

export function createContext(req: http.IncomingMessage, res: http.ServerResponse): RequestContext {
  return {
    req,
    res,
    clientIp: (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress ?? 'unknown',
    startTime: performance.now(),
    metadata: {},
  };
}
