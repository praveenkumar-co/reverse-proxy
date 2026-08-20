import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../../types/upstream.types.js';

export class IpHashStrategy implements IStrategy {
  private fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  pick(candidates: UpstreamState[], clientIp?: string): UpstreamState | null {
    if (candidates.length === 0) return null;
    if (!clientIp) return candidates[0]!;
    return candidates[this.fnv1a(clientIp) % candidates.length]!;
  }
}
