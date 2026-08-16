export interface UpstreamState {
  id: string;
  weight: number;
  activeConnections: number;
  failures: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  lastFailureTime: number;
  responseTime: number; // EWMA latency
  healthy: boolean;      // Health probe status
  requests: number;      // Decayed request count for SRE
  accepts: number;       // Decayed accept count for SRE
  slowStartEndTime: number;
  maxConnections?: number | undefined;
  currentWeight: number;
}
