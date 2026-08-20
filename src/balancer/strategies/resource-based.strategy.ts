import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class ResourceBasedStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;
    return candidates.reduce((prev, curr) => {
      const prevScore = prev.activeConnections / Math.max(1, prev.weight);
      const currScore = curr.activeConnections / Math.max(1, curr.weight);
      return currScore < prevScore ? curr : prev;
    });
  }
}
