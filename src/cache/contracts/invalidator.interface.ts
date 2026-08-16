export interface IInvalidator {
  invalidate(pattern: string): Promise<void>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}
