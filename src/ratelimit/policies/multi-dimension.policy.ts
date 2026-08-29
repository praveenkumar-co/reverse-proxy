export type Dimension = 'ip' | 'api-key' | 'route' | 'header';
export interface DimensionConfig {
  dimension: Dimension;
  maxRequests: number;
  windowMs: number;
  headerName?: string;
}
export class MultiDimensionPolicy {
  constructor(private dimensions: DimensionConfig[]){}
  buildKey(dimension: Dimension, value: string, route: string): string {
    return `rl:${dimension}:${route}:${value}`;
  }
  getDimensions(): DimensionConfig[] {
    return this.dimensions;
  }
}
