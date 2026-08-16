export function calculateFullJitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const limit = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  return Math.random() * limit;
}
