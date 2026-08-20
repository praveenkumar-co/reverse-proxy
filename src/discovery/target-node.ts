export interface TargetNode {
  id: string;
  url: string;
  weight: number;
  healthy: boolean;
  metadata?: Record<string, string>;
}

export function createTargetNode(partial: Partial<TargetNode> & { id: string; url: string }): TargetNode {
  return {
    weight: 1,
    healthy: true,
    ...partial,
  };
}