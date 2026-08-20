import type { ServiceInstance } from '../registry/dynamic.registry.js';

export interface IRegistry {
  register(instance: Omit<ServiceInstance, 'registeredAt' | 'lastHeartbeat' | 'status'>): ServiceInstance;
  get(id: string): ServiceInstance | undefined;
  getAll(): ServiceInstance[];
  getHealthy(): ServiceInstance[];
  deregister(id: string): boolean;
  heartbeat(id: string): boolean;
  onRegister(cb: (service: ServiceInstance) => void): void;
  onDeregister(cb: (service: ServiceInstance) => void): void;
  getStats(): object;
}
