export interface IRegistry {
  register(service: { id: string; url: string; metadata?: Record<string, string> }): any;
  get(id: string): { id: string; url: string; metadata?: Record<string, string> } | undefined;
  getAll(): Array<{ id: string; url: string; metadata?: Record<string, string> }>;
  deregister(id: string): void;
}
