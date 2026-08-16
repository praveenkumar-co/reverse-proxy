import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../core/upstream-state.js';

export class RandomStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)]!;
  }
}
