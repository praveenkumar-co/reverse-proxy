import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class AdaptiveWrrStrategy implements IStrategy {
  constructor(private slowStartSeconds: number = 30){}

  pick(candidates: UpstreamState[]): UpstreamState | null {
    if(candidates.length === 0) return null;
    const now = Date.now();
    let total = 0;
    const weights = candidates.map((s) => {
      const errorRate = s.failures / (s.requests + 1);
      let weight = Math.max(
        1,
        Math.round(s.weight * (1 / (1 + s.responseTime / 100)) * (1 - errorRate))
      );
      if(s.slowStartEndTime > 0 && now < s.slowStartEndTime){
        const timeLeft = s.slowStartEndTime - now;
        const progress = 1 - timeLeft / (this.slowStartSeconds * 1000);
        weight = Math.max(1, Math.round(weight * progress));
      }
      total += weight;
      return weight;
    });
    let randomWeight = Math.floor(Math.random() * total);
    for(let i = 0; i < candidates.length; i++){
      randomWeight -= weights[i]!;
      if(randomWeight < 0){
        return candidates[i] ?? null;
      }
    }
    return candidates[0] ?? null;
  }
}
