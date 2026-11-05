export interface IInvalidator {
  invalidate(pattern: string): Promise<number>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}
