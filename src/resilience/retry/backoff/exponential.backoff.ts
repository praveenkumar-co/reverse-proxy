export function calculateExponentialBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
}
