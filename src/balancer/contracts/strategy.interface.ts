import type { UpstreamState } from "../../types/upstream.types.js";

export interface IStrategy {
  pick(
    candidates: UpstreamState[],
    clientIp?: string,
    cookies?: string,
  ): UpstreamState | null;
  onUpstreamsChanged?(upstreams: UpstreamState[]): void;
}
