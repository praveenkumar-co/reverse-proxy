import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../../types/upstream.types.js';

export class LeastResponseTimeStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => b.responseTime < a.responseTime ? b : a);
  }
}
