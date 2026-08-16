export function calculateDecorrelatedJitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  previousSleepMs?: number,
): number {
  const prev = previousSleepMs ?? baseDelayMs;
  const nextLimit = prev * 3;
  const sleep = baseDelayMs + Math.random() * Math.max(0, nextLimit - baseDelayMs);
  return Math.min(maxDelayMs, sleep);
}
