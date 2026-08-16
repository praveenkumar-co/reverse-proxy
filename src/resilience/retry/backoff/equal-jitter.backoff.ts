export function calculateEqualJitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const limit = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const halfLimit = limit / 2;
  return halfLimit + Math.random() * halfLimit;
}
