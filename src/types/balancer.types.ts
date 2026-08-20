export interface LoadBalancerOptions {
  strategy: string;
  upstreams: any[];
  failureThreshold?: number;
  recoveryTimeMs?: number;
  virtualNodes?: number;
  ewmaAlpha?: number;
  stickyCookieName?: string;
  slowStartSeconds?: number;
  circuitBreaker?: {
    mode: "classic" | "adaptive";
    failureThreshold: number;
    recoveryTimeMs: number;
    K: number;
    windowMs: number;
  } | undefined;
}
