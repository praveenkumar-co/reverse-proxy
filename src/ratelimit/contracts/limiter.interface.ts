export interface ILimiter {
  isAllowed(key: string): boolean | Promise<boolean>;
  getResetTime(key: string): number;
  getAlgorithm(): string;
}
