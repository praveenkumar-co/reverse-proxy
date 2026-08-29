import type { IInvalidator } from '../contracts/invalidator.interface.js';

export class PatternInvalidator implements IInvalidator {
  constructor(private cache: { invalidate: (p: string) => Promise<void> }){}

  async invalidate(pattern: string): Promise<void> {
    await this.cache.invalidate(pattern);
  }
}
