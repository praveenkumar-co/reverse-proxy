import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class WeightedLeastConnectionsStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if(candidates.length === 0) return null;
    return candidates.reduce((prev, curr) => {
      const prevScore = prev.activeConnections / (prev.weight || 1);
      const currScore = curr.activeConnections / (curr.weight || 1);
      return currScore < prevScore ? curr : prev;
    });
  }
}
