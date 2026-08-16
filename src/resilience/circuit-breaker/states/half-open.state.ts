export class HalfOpenState {
  readonly name = 'HALF_OPEN' as const;
  shouldClose(consecutiveSuccesses: number, threshold = 1): boolean {
    return consecutiveSuccesses >= threshold;
  }
}
