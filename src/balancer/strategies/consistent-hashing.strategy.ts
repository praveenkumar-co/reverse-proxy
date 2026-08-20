import type { IStrategy } from "../contracts/strategy.interface.js";
import type { UpstreamState } from "../../types/upstream.types.js";

export class ConsistentHashingStrategy implements IStrategy {
  private ring: Array<{ hash: number; id: string }> = [];
  private virtualNodes: number;

  constructor(virtualNodes: number = 150) {
    this.virtualNodes = virtualNodes;
  }

  onUpstreamsChanged(upstreams: UpstreamState[]): void {
    this.ring = [];
    for (const u of upstreams) {
      for (let i = 0; i < this.virtualNodes; i++) {
        this.ring.push({
          hash: this.fnv1a(`${u.id}#vnode${i}`),
          id: u.id,
        });
      }
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  private fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
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
    if (candidates.length === 0) return null;
    if (!clientIp) return candidates[0]!;

    const hash = this.fnv1a(clientIp);
    const ringMatch =
      this.ring.find((node) => node.hash >= hash) ?? this.ring[0];

    if (!ringMatch) return candidates[0]!;

    return (
      candidates.find((s) => s.id === ringMatch.id) ?? candidates[0]!
    );
  }
}
