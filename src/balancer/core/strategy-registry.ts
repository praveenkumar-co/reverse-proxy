import type { IStrategy } from '../contracts/strategy.interface.js';

export class StrategyRegistry {
private registry = new Map<string, IStrategy>();
register(name: string, strategy: IStrategy){
    this.registry.set(name, strategy);
  }
get(name: string): IStrategy | undefined {
    return this.registry.get(name);
  }
}
export const strategyRegistry = new StrategyRegistry();