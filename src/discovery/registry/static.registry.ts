import type { IRegistry } from '../contracts/registry.interface.js';

export class StaticRegistry implements IRegistry {
  private services = new Map<string, { id: string; url: string; metadata?: Record<string, string> }>();

  constructor(services: Array<{ id: string; url: string; metadata?: Record<string, string> }>) {
    for (const s of services) this.services.set(s.id, s);
  }

  register(service: { id: string; url: string; metadata?: Record<string, string> }) {
    this.services.set(service.id, service);
    return service;
  }

  get(id: string) {
    return this.services.get(id);
  }

  getAll() {
    return [...this.services.values()];
  }

  deregister(id: string) {
    this.services.delete(id);
  }
}
