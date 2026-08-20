export interface IStrategy {
  pick(
    candidates: import("../../types/upstream.types.js").UpstreamState[],
    clientIp?: string,
  ): import("../../types/upstream.types.js").UpstreamState | null;
}
