import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../core/upstream-state.js';

export class StickySessionsStrategy implements IStrategy {
  constructor(private cookieName: string) {}

  pick(candidates: UpstreamState[], _clientIp?: string, cookies?: string): UpstreamState | null {
    if (candidates.length === 0) return null;
    if (cookies) {
      const match = cookies.match(new RegExp(`(?:^|; )${this.cookieName}=([^;]*)`) );
      if (match?.[1]) {
        const found = candidates.find(c => c.id === match[1]);
        if (found) return found;
      }
    }
    return candidates[0]!;
  }
}
