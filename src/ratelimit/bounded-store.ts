/**
 * A Map-backed key/value store with two independent memory-safety mechanisms, used by every
 * in-memory rate-limit algorithm to prevent unbounded growth from high-cardinality keys
 * (e.g. spoofed client IPs):
 *
 *  1. A periodic sweep that purges entries the caller's `isExpired` predicate considers stale.
 *     The sweep timer is started lazily on first write and unref'd so it never keeps the
 *     process alive.
 *  2. A hard max-entry cap enforced on every write, evicting the least-recently-touched entry
 *     first. This is a safety valve against bursts that outrun the sweep interval — the sweep
 *     handles the common case (stale keys reclaimed on a schedule); the cap handles the
 *     worst case (an attacker creating more distinct keys than could ever expire naturally).
 */
export class BoundedStore<V> {
  private store = new Map<string, V>();
  private sweepTimer: NodeJS.Timeout | undefined = undefined;

  constructor(
    private readonly isExpired: (value: V, now: number) => boolean,
    private readonly maxEntries = 50_000,
    private readonly sweepIntervalMs = 60_000,
  ) {}

  get(key: string): V | undefined {
    return this.store.get(key);
  }

  set(key: string, value: V): void {
    this.ensureSweepStarted();
    // Delete-then-set moves the key to the end of Map's insertion order, which this class
    // uses as its recency order for eviction.
    this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  private ensureSweepStarted(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.store) {
      if (this.isExpired(value, now)) this.store.delete(key);
    }
  }

  /** Test/shutdown hook — stops the background sweep timer. */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
