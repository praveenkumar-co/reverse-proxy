export interface PickContext {
  clientIp?: string;
  attemptedIds?: Set<string>;
  cookies?: string;
  headers?: Record<string, string>;
}
