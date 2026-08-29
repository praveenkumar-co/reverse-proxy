import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class IpHashStrategy implements IStrategy {
  private fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for(let i = 0; i < str.length; i++){
      hash ^= str.charCodeAt(i);
      hash += 
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24);
    }
    return hash >>> 0;
  }
  pick(
    candidates: UpstreamState[],
    clientIp?: string,
  ): UpstreamState | null {
    if(candidates.length === 0) return null;
    if(!clientIp) return candidates[0]!;
    const hash = this.fnv1a(clientIp);
    return candidates[hash % candidates.length]!;
  }
}
