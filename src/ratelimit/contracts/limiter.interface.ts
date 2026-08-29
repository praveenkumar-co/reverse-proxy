export interface ILimiter {
  isAllowed(
    key: string,
    context?: {
      apiKey?: string;
      route?: string;
      headers?: Record<string, string | string[] | undefined>;
    }
  ): boolean | Promise<boolean>;
  getResetTime(key: string): number;
  getAlgorithm(): string;
  getRemaining(key: string): number | Promise<number>;
}
