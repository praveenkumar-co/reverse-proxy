import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../../types/upstream.types.js';

export class WeightedRoundRobinStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    const total = candidates.reduce((s, c) => s + c.weight, 0);
    for (const c of candidates) c.currentWeight += c.weight;
    const best = candidates.reduce((a, b) => b.currentWeight > a.currentWeight ? b : a);
    best.currentWeight -= total;
    return best;
  }
}
