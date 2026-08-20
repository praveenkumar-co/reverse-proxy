import type { IStrategy } from '../contracts/strategy.interface.js';
import type { UpstreamState } from '../../types/upstream.types.js';

export class ConsistentHashingStrategy implements IStrategy {
  private ring: Array<{ hash: number; id: string }> = [];

  buildRing(candidates: UpstreamState[], virtualNodes: number) {
    this.ring = [];
    for(const c of candidates){
      for(let i = 0; i < virtualNodes; i++){
        this.ring.push({ hash: this.fnv1a(`${c.id}:${i}`), id: c.id });
      }
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  private fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for(let i = 0; i < str.length; i++){
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  pick(candidates: UpstreamState[], clientIp?: string): UpstreamState | null{
    if(candidates.length === 0) return null;
    if(!clientIp) return candidates[0]!;
    const hash = this.fnv1a(clientIp);
    let idx = this.ring.findIndex(n => n.hash >= hash);
    if(idx === -1) idx = 0;
    const targetId = this.ring[idx]?.id;
    return candidates.find(c => c.id === targetId) ?? candidates[0]!;
  }
}
