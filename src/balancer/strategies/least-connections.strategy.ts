import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class LeastConnectionsStrategy implements IStrategy {
  pick(candidates: UpstreamState[]): UpstreamState | null {
    if(candidates.length === 0) return null;
    return candidates.reduce((prev, curr) =>
      curr.activeConnections < prev.activeConnections ? curr : prev,
    );
  }
}
