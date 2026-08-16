import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../core/upstream-state.js';

export class WeightedLeastConnectionsStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => {
      const ra = a.activeConnections / a.weight;
      const rb = b.activeConnections / b.weight;
      return rb < ra ? b : a;
    });
  }
}
