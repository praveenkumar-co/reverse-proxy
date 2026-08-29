import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class WeightedRoundRobinStrategy implements IStrategy {
  constructor(private slowStartSeconds: number = 30){}

  pick(candidates: UpstreamState[]): UpstreamState | null {
    if(candidates.length === 0) return null;
    const now = Date.now();
    let best: UpstreamState | null = null;
    let totalWeight = 0;
    for(const s of candidates){
      let effectiveWeight = s.weight;
      if(s.slowStartEndTime > 0 && now < s.slowStartEndTime){
        const timeLeft = s.slowStartEndTime - now;
        const progress = 1 - timeLeft / (this.slowStartSeconds * 1000);
        effectiveWeight = Math.max(1, Math.floor(s.weight * progress));
      }
      s.currentWeight += effectiveWeight;
      totalWeight += effectiveWeight;
      if(!best || s.currentWeight > best.currentWeight){
        best = s;
      }
    }
    if(best){
      best.currentWeight -= totalWeight;
    }
    return best;
  }
}
