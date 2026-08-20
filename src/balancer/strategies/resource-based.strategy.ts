import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";
import { registry } from "../../discovery/registry/dynamic.registry.js";

export class ResourceBasedStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    return candidates.reduce((prev, curr) => {
      const prevScore = this.score(prev);
      const currScore = this.score(curr);
      return currScore < prevScore ? curr : prev;
    });
  }
  private score(state: UpstreamState): number {
    const svc = registry.get(state.id);
    if (svc?.metadata) {
      const cpu = parseFloat(svc.metadata["cpu"] ?? "0");
      const mem = parseFloat(svc.metadata["memory"] ?? "0");
      if (!isNaN(cpu) && !isNaN(mem)) {
        return cpu * 0.7 + mem * 0.3;
      }
    }
    return state.activeConnections / Math.max(1, state.weight);
  }
}
