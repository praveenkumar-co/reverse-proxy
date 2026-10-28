import { logger } from "./logger.js";

export interface TenantLogEntry {
  timestamp: string;
  clientIp: string;
  method: string;
  url: string;
  statusCode: number;
  bytesSent: number;
  latencyMs: number;
  userAgent: string;
}

export class TenantLogStreamer {
  private queue = new Map<string, TenantLogEntry[]>();
  private endpoints = new Map<string, string>(); // tenantId -> destination URL
  private intervalId: NodeJS.Timeout | null = null;
  private globalSize = 0;
  private readonly MAX_TENANT_QUEUE = 10000;
  private readonly MAX_GLOBAL_QUEUE = 50000; 

  public configure(endpoints: { tenantId: string; destination: string }[]){
    this.endpoints.clear();
    for (const ep of endpoints){
      this.endpoints.set(ep.tenantId, ep.destination);
    }
    this.start();
  }

  public queueLog(tenantId: string, log: TenantLogEntry){
    if (!this.endpoints.has(tenantId)) return; // Drop unmapped traffic immediately
    if (this.globalSize >= this.MAX_GLOBAL_QUEUE) return;

    let tenantQueue = this.queue.get(tenantId);
    if (!tenantQueue){
      tenantQueue = [];
      this.queue.set(tenantId, tenantQueue);
    }

    if (tenantQueue.length >= this.MAX_TENANT_QUEUE) return;

    tenantQueue.push(log);
    this.globalSize++;
  }

  public start(){
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.flush(), 1000);
    this.intervalId.unref();
  }

  public stop(){
    if (this.intervalId !== null){
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public async flush(){
    if (this.globalSize === 0) return;

    // Flushed in parallel rather than one tenant awaited after another — previously a single
    // slow or unreachable webhook delayed every other tenant's logs behind it (head-of-line
    // blocking), even though they share nothing but this one interval timer.
    const tasks: Promise<void>[] = [];
    for (const [tenantId, entries] of this.queue.entries()){
      if (entries.length === 0) continue;

      const destination = this.endpoints.get(tenantId);
      if (!destination){
        this.globalSize -= entries.length;
        this.queue.set(tenantId, []);
        continue;
      }

      const batch = entries.splice(0, entries.length);
      this.globalSize -= batch.length;

      tasks.push(this.sendLogs(tenantId, destination, batch));
    }
    await Promise.all(tasks);
  }

  private async sendLogs(tenantId: string, destination: string, logs: TenantLogEntry[], attempt = 0): Promise<void> {
    try {
      const response = await fetch(destination, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tenant-ID": tenantId,
        },
        body: JSON.stringify({ tenantId, logs }),
        // Bounds how long one tenant's unreachable/slow webhook can occupy this attempt —
        // without it, a hanging fetch() never resolves and this batch of logs is held
        // forever rather than being retried or dropped.
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok){
        logger.warn(`TenantLogStreamer:${process.pid}`, `Webhook response failed for tenant ${tenantId}: ${response.statusText}`);
      }
    } catch (err: any){
      if (attempt < 1){
        return this.sendLogs(tenantId, destination, logs, attempt + 1);
      }
      logger.error(`TenantLogStreamer:${process.pid}`, `Failed to dispatch logs to tenant ${tenantId} webhook after retry: ${err.message}`);
    }
  }
}

export const tenantLogStreamer = new TenantLogStreamer();
