export class SoftLimitPolicy {
  constructor(
    private hardLimit: number,
    private softLimit: number,
    private burstMultiplier = 1.5
  ) {}

  effectiveLimit(currentLoad: number): number {
    if (currentLoad < this.softLimit) return Math.floor(this.hardLimit * this.burstMultiplier);
    return this.hardLimit;
  }
}
