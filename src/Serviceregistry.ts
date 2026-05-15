export interface ServiceInstance {
  id: string;
  url: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: 'UP' | 'DOWN';
  metadata?: Record<string, string>;
}

export interface RegistryConfig {
  heartbeatTimeoutMs?: number;
  cleanupIntervalMs?: number;
}

export class ServiceRegistry {
  private services: Map<string, ServiceInstance> = new Map();
  private heartbeatTimeoutMs: number;
  // on every registry of a function 
  private onRegisterCallbacks: ((service: ServiceInstance) => void)[] = [];
  private onDeregisterCallbacks: ((service: ServiceInstance) => void)[] = [];

  constructor(config: RegistryConfig) {
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 30_000;
    setInterval(() => {
      this.checkHeartbeats();
    }, config.cleanupIntervalMs ?? 10_000);
  }
  register(instance: Omit<ServiceInstance, 'registeredAt' | 'lastHeartbeat' | 'status'>): ServiceInstance {
    const service: ServiceInstance = {
      ...instance,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      // mark the incoming server to UP 
      status: 'UP',
    };
    this.services.set(instance.id, service);
    console.log(`[Registry] Service REGISTERED: ${instance.id} → ${instance.url}`);
    this.onRegisterCallbacks.forEach(callback => callback(service));
    return service;
  }
  deregister(id: string): boolean {
    const service = this.services.get(id);
    if (!service) {
      return false;
    }
    service.status = 'DOWN';
    this.services.delete(id);
    console.log(`[Registry] Service DEREGISTERED: ${id}`);
    this.onDeregisterCallbacks.forEach(callback => callback(service));
    return true;
  }
  heartbeat(id: string): boolean {
    const service = this.services.get(id);
    if (!service) {
      return false;
    }
    service.lastHeartbeat = Date.now();
    service.status = 'UP';
    return true;
  }
  // to get all up services
  getHealthy(): ServiceInstance[] {
    return [...this.services.values()].filter(s => s.status === 'UP');
  }
  getAll(): ServiceInstance[] {
    return [...this.services.values()];
  }
  // get single service 
  get(id: string): ServiceInstance | undefined {
    return this.services.get(id);
  }
  // to check heartbeat is consistent or not 
  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [id, service] of this.services) {
      if (
        service.metadata?.dynamic === "true" &&
        service.status === 'UP' &&
        now - service.lastHeartbeat > this.heartbeatTimeoutMs
      ) {
        console.log(`[Registry] Service TIMED OUT (no heartbeat): ${id}`);
        service.status = 'DOWN';
        this.onDeregisterCallbacks.forEach(callback => callback(service));
      }
    }
  }
  onRegister(cb: (service: ServiceInstance) => void): void {
    this.onRegisterCallbacks.push(cb);
  }

  onDeregister(cb: (service: ServiceInstance) => void): void {
    this.onDeregisterCallbacks.push(cb);
  }
  getStats(): object {
    return {
      total: this.services.size,
      healthy: this.getHealthy().length,
      services: this.getAll().map(s => ({
        id: s.id,
        url: s.url,
        status: s.status,
        uptime: `${Math.floor((Date.now() - s.registeredAt) / 1000)}s`,
        lastHeartbeat: `${Math.floor((Date.now() - s.lastHeartbeat) / 1000)}s ago`,
        metadata: s.metadata,
      })),
    };
  }
}
export const registry = new ServiceRegistry({
  heartbeatTimeoutMs: 30_000,
  cleanupIntervalMs: 10_000
})