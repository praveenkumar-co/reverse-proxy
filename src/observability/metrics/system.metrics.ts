import os from 'os';

export interface SystemMetrics {
  cpuUsage: number;
  memUsedMb: number;
  memTotalMb: number;
  loadAvg1m: number;
  uptime: number;
}

export function collectSystemMetrics(): SystemMetrics {
  const memUsed = process.memoryUsage();
  return {
    cpuUsage: os.loadavg()[0] ?? 0,
    memUsedMb: Math.round(memUsed.rss / 1024 / 1024),
    memTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    loadAvg1m: os.loadavg()[0] ?? 0,
    uptime: process.uptime(),
  };
}

export function systemMetricsToPrometheus(metrics: SystemMetrics): string {
  return [
    `ninja_proxy_cpu_load ${metrics.cpuUsage}`,
    `ninja_proxy_memory_used_mb ${metrics.memUsedMb}`,
    `ninja_proxy_memory_total_mb ${metrics.memTotalMb}`,
    `ninja_proxy_uptime_seconds ${metrics.uptime}`,
  ].join('\n') + '\n';
}
