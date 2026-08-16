export interface RouteRule {
  path: string;
  upstream: string[];
  methods?: string[];
  rateLimit?: { maxRequests: number; windowMs: number; algorithm: string };
  cache?: { enabled: boolean; ttlSeconds?: number };
  sticky?: boolean;
  stripPrefix?: boolean;
}
