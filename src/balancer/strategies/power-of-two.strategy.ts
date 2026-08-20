import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../../types/upstream.types.js';

export class PowerOfTwoStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    const i1 = Math.floor(Math.random() * candidates.length);
    let i2 = Math.floor(Math.random() * candidates.length);
    while (i2 === i1 && candidates.length > 1) i2 = Math.floor(Math.random() * candidates.length);
    const a = candidates[i1]!;
    const b = candidates[i2]!;
    return a.activeConnections <= b.activeConnections ? a : b;
  }
}
