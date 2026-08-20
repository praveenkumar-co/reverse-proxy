import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../../types/upstream.types.js';
import { registry } from '../../discovery/registry/dynamic.registry.js';

export class ResourceBasedStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => {
      const sa = this.score(a.id);
      const sb = this.score(b.id);
      return sb < sa ? b : a;
    });
  }

  private score(id: string): number {
    const r = registry.get(id);
    if (r?.metadata) {
      const cpu = parseFloat(r.metadata['cpu'] ?? '0');
      const mem = parseFloat(r.metadata['memory'] ?? '0');
      return cpu * 0.7 + mem * 0.3;
    } 
    return 0;
  }
}
