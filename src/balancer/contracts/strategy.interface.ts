export interface IStrategy {
  pick(candidates: import('../core/upstream-state.js').UpstreamState[], clientIp?: string): import('../core/upstream-state.js').UpstreamState | null;
}
