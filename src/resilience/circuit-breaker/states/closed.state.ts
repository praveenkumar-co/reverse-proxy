export class ClosedState {
  readonly name = 'CLOSED' as const;
  shouldTrip(failures: number, threshold: number): boolean {
    return failures >= threshold;
  }
}
