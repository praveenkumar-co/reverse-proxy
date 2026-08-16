import type { IRegistry } from '../contracts/registry.interface.js';

export class ConsulRegistry implements IRegistry {
  private cache = new Map<string, { id: string; url: string; metadata?: Record<string, string> }>();

  constructor(private _consulHost: string, private _consulPort: number) {}

  register(service: { id: string; url: string; metadata?: Record<string, string> }) {
    this.cache.set(service.id, service);
    return service;
  }

  get(id: string) {
    return this.cache.get(id);
  }

  getAll() {
    return [...this.cache.values()];
  }

  deregister(id: string) {
    this.cache.delete(id);
  }
}
