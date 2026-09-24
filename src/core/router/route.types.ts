export interface CanaryConfig {
  enabled: boolean;
  canaryUpstream: string;
  baselineUpstream?: string;
  weight?: number;
  stickyCookieName?: string;
  headerKey?: string;
  headerValue?: string;
  stage?: string;
  allowedIps?: string[];
  stripHeader?: boolean;
  maxConnections?: number;
}

export interface RouteRule {
  path: string;
  upstream: string[];
  methods?: string[];
  rateLimit?: { maxRequests: number; windowMs: number; algorithm: string };
  cache?: { enabled: boolean; ttlSeconds?: number };
  sticky?: boolean;
  stripPrefix?: boolean;
  canary?: CanaryConfig;
}

