import type { IInvalidator } from '../contracts/invalidator.interface.js';

/**
 * Rejects a pattern with no literal prefix before the first wildcard — e.g. "*", "*foo",
 * "?bar" — since purging that would mean scanning (and potentially evicting) every key in
 * the keyspace, not just this tenant's. A tenant-scoped pattern like "proxy:tenant-42:*" is
 * fine; a bare "*" or "*shared-suffix" is not, because any other tenant's keys can match it.
 */
function hasLiteralPrefix(pattern: string): boolean {
  const firstWildcard = pattern.search(/[*?]/);
  return firstWildcard > 0;
}

export class PatternInvalidator implements IInvalidator {
  constructor(private cache: { invalidate: (p: string) => Promise<number> }){}

  async invalidate(pattern: string): Promise<number> {
    if (!hasLiteralPrefix(pattern)) {
      throw new Error(
        `Refusing to invalidate pattern "${pattern}": no literal prefix before the first wildcard, which would match keys across every tenant`,
      );
    }
    return await this.cache.invalidate(pattern);
  }
}
