import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../core/upstream-state.js';

export class RoundRobinStrategy implements IStrategy {
  private index = 0;
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    const item = candidates[this.index % candidates.length]!;
    this.index = (this.index + 1) % candidates.length;
    return item;
  }
}
