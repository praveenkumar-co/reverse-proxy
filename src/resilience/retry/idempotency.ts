export const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Mutating methods (POST/PUT/PATCH/DELETE) risk duplicate side effects on the backend if
 * blindly retried after a failed/ambiguous response (e.g. the request was processed but the
 * reply was lost). Only retry them automatically when the client has opted in via an
 * Idempotency-Key header, or when the operator has explicitly enabled it for all mutations.
 *
 * Single source of truth shared by master.ts's IPC dispatch retry loop and by
 * IdempotentRetryPolicy (for any RetryHandler-based retry elsewhere) — both must agree on
 * what's safe to retry.
 */
export function isMethodRetrySafe(
  method: string,
  headers: Record<string, any>,
  allowMutatingRetries: boolean,
): boolean {
  if (IDEMPOTENT_METHODS.has(method.toUpperCase())) return true;
  if (headers?.["idempotency-key"]) return true;
  return allowMutatingRetries === true;
}
