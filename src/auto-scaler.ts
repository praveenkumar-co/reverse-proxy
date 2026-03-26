import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { registry } from "./Serviceregistry.js";
// to import constructor from different files use 'type' keyword
import type { LoadBalancer } from "./loadBalancer.js";

export interface AutoScalerConfig {
  minServers: number;
  maxServers: number;
  scaleUpAt: number;
  scaleDownAt: number;
  cooldownMs: number;
  startPort: number;
  proxyPort: number;
}

interface SpawnedServer {
  id: string;
  port: number;
  process: ChildProcess;
  spawnedAt: number;
}

export class AutoScaler {
  private config: AutoScalerConfig;
  // loadBalancer to get activeConnections with that servers
  private lb: LoadBalancer;
  private spawnedServers: Map<string, SpawnedServer> = new Map();
  private lastScaleAction: number = 0;
  private nextPort: number;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(config: AutoScalerConfig, lb: LoadBalancer) {
    this.config = config;
    this.lb = lb;
    this.nextPort = config.startPort;
  }
  start(): void {
    console.log(
      `[AutoScaler] Started — min:${this.config.minServers} max:${this.config.maxServers}`
    );
    this.monitorInterval = setInterval(() => {
      this.monitor();
    }, 5000);
  }
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    for (const [id] of this.spawnedServers) {
      this.killServer(id);
    }
    console.log(`[AutoScaler] Stopped`);
  }

  private monitor(): void {
    const stats = this.lb.getStats();
    const now = Date.now();

    // to get total Active Connections :
    const totalConnections = Object.values(stats).reduce(
      (sum: number, s: any) => {
        return sum + (s.activeConnections ?? 0);
      },
      0
    );
    console.log(`[AutoScaler] totalConnections: ${totalConnections}`);
    const healthyCount = registry.getHealthy().length;
    // since spawnedServers is an Map so its length will not exist instead of size will be there
    const autoCount = this.spawnedServers.size;
    console.log(
      `[AutoScaler] Connections: ${totalConnections} | Servers: ${healthyCount} (${autoCount} auto-scaled)`
    );

    if (now - this.lastScaleAction < this.config.cooldownMs) {
      console.log(`[AutoScaler] Cooldown active — waiting...`);
      return;
    }
    // Scaling Up :
    if (
      totalConnections > this.config.scaleUpAt &&
      healthyCount < this.config.maxServers
    ) {
      console.log(
        `[AutoScaler] SCALE UP — connections: ${totalConnections} > threshold: ${this.config.scaleUpAt}`
      );
      this.spawnServer();
      this.lastScaleAction = now;
      return;
    }
    // scale down
    if (
      totalConnections < this.config.scaleDownAt &&
       healthyCount > this.config.minServers &&
      autoCount > 0
    ) {
      console.log(
        `[AutoScaler] SCALE DOWN — connections: ${totalConnections} < threshold: ${this.config.scaleDownAt}`
      );
      this.killOldestServer();
      this.lastScaleAction = now;
      return;
    }
  }
  private spawnServer(): void {
    const port = this.nextPort++;
    const id = `auto-node-${port}`;

    console.log(`[AutoScaler] Spawning ${id} on port ${port}...`);

   const child = spawn("node", ["server-template.js"], {
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        SERVER_ID: id,
        PROXY_PORT: String(this.config.proxyPort),
      },
      stdio: "pipe", // capture output
    });
    child.stdout?.on("data", (data) => {
      console.log(`[${id}] ${data.toString().trim()}`);
    });

    child.stderr?.on("data", (data) => {
      console.error(`[${id} ERROR] ${data.toString().trim()}`);
    });

    child.on("exit", (code) => {
      console.log(`[AutoScaler] ${id} exited with code ${code}`);
      this.spawnedServers.delete(id);
    });

    this.spawnedServers.set(id, {
      id,
      port,
      process: child,
      spawnedAt: Date.now(),
    });

    console.log(`[AutoScaler]${id} spawned on port ${port}`);
  }

  private killOldestServer(): void {
    let oldest: SpawnedServer | null = null;
    for (const [, server] of this.spawnedServers) {
      if (!oldest || server.spawnedAt < oldest.spawnedAt) {
        oldest = server;
      }
    }
    if (oldest) {
      this.killServer(oldest.id);
    }
  }
  private killServer(id: string): void {
    const server = this.spawnedServers.get(id);
    if (!server) return;

    console.log(`[AutoScaler] Killing ${id}...`);
    server.process.kill("SIGTERM"); // graceful shutdown
    this.spawnedServers.delete(id);
  }

  getStats(): object {
    return {
      spawnedServers: this.spawnedServers.size,
      servers: [...this.spawnedServers.values()].map((s) => ({
        id: s.id,
        port: s.port,
        uptime: `${Math.floor((Date.now() - s.spawnedAt) / 1000)}s`,
      })),
      config: {
        minServers: this.config.minServers,
        maxServers: this.config.maxServers,
        scaleUpAt: this.config.scaleUpAt,
        scaleDownAt: this.config.scaleDownAt,
      },
    };
  }
}


