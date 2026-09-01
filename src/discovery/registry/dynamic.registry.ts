import { promises as fs } from "fs";
import { existsSync } from "fs";
import { logger } from "../../observability/logger/logger.js";

export interface ServiceInstance {
  id: string;
  url: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: "UP" | "DOWN";
  metadata?: Record<string, string>;
}
export interface RegistryConfig {
  heartbeatTimeoutMs?: number;
  cleanupIntervalMs?: number;
  persistencePath?: string;
}
export class ServiceRegistry {
  private services: Map<string, ServiceInstance> = new Map();
  private heartbeatTimeoutMs: number;
  private persistencePath: string;
  private onRegisterCallbacks: ((service: ServiceInstance) => void)[] = [];
  private onDeregisterCallbacks: ((service: ServiceInstance) => void)[] = [];
  constructor(config: RegistryConfig){
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 30_000;
    const isTest = typeof process !== "undefined" && (process.env.NODE_ENV === "test" || process.env.TAP === "1");
    this.persistencePath = config.persistencePath ?? (isTest ? "proxy_registry_backup.test.json" : "proxy_registry_backup.json");
    this.loadSnapshot();
    const timer = setInterval(() => {
      this.checkHeartbeats();
    }, config.cleanupIntervalMs ?? 10_000);
    if(timer.unref){
      timer.unref();
    }
  }
  private async loadSnapshot(){
    if(!existsSync(this.persistencePath)) return;
    try {
      const data = await fs.readFile(this.persistencePath, "utf-8");
      const saved = JSON.parse(data);
      const now = Date.now();
      for (const key of Object.keys(saved)){
        const item = saved[key] as ServiceInstance;
        item.lastHeartbeat = now;
        item.registeredAt = now;
        this.services.set(key, item);
      }
      logger.info("Registry", `Rehydrated ${Object.keys(saved).length} services from disk snapshot`);
    } catch (err: any){
      logger.error("Registry", `Failed to load disk snapshot: ${err.message}`);
    }
  }
  private async saveSnapshot(){
    try{
      const plainObj: Record<string, ServiceInstance> = {};
      for(const [id, s] of this.services.entries()){
        plainObj[id] = s;
      }
      await fs.writeFile(this.persistencePath, JSON.stringify(plainObj, null, 2), "utf-8");
    }catch (err: any){
      logger.error("Registry", `Failed to save disk snapshot: ${err.message}`);
    }
  }
  register(
    instance: Omit<ServiceInstance, "registeredAt" | "lastHeartbeat" | "status">,
  ): ServiceInstance {
    const service: ServiceInstance = {
      ...instance,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      status: "UP",
    };
    this.services.set(instance.id, service);
    logger.info("Registry", `Service REGISTERED: ${instance.id} → ${instance.url}`, { id: instance.id, url: instance.url });
    this.onRegisterCallbacks.forEach((callback) => callback(service));
    this.saveSnapshot();
    return service;
  }
  deregister(id: string): boolean {
    const service = this.services.get(id);
    if(!service){
      return false;
    }
    service.status = "DOWN";
    this.services.delete(id);
    logger.info("Registry", `Service DEREGISTERED: ${id}`, { id });
    this.onDeregisterCallbacks.forEach((callback) => callback(service));
    this.saveSnapshot();
    return true;
  }
  heartbeat(id: string): boolean {
    const service = this.services.get(id);
    if(!service){
      return false;
    }
    service.lastHeartbeat = Date.now();
    service.status = "UP";
    return true;
  }
  getHealthy(): ServiceInstance[] {
    return [...this.services.values()].filter((s) => s.status === "UP");
  }
  getAll(): ServiceInstance[] {
    return [...this.services.values()];
  }
  get(id: string): ServiceInstance | undefined {
    return this.services.get(id);
  }
  private checkHeartbeats(): void {
    const now = Date.now();
    let changed = false;
    for(const [id, service] of this.services){
      if(
        service.metadata?.["dynamic"] === "true" &&
        service.status === "UP" &&
        now - service.lastHeartbeat > this.heartbeatTimeoutMs
      ){
        logger.warn("Registry", `Service TIMED OUT (no heartbeat): ${id}`, { id });
        service.status = "DOWN";
        this.onDeregisterCallbacks.forEach((callback) => callback(service));
        changed = true;
      }
    }
    if(changed){
      this.saveSnapshot();
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
      services: this.getAll().map((s) => ({
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
  cleanupIntervalMs: 10_000,
});
