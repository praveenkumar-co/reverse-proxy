import os from 'os';

export interface SystemMetrics {
  cpuUsage: number;
  memUsedMb: number;
  memTotalMb: number;
  loadAvg1m: number;
  uptime: number;
  // Breaks RSS down into the three buckets that matter when diagnosing a growth: the V8 heap
  // itself (heapUsed), and the two native-memory pools outside it that RSS also counts but a
  // JS heap snapshot can't see — arrayBuffers (typed arrays / Node Buffers) and external
  // (everything else native, e.g. sockets, zlib/TLS contexts). A leak that's all RSS growth
  // with flat heapUsed/arrayBuffers/external is OS/connection-level, not a JS object leak.
  heapUsedMb: number;
  arrayBuffersMb: number;
  externalMb: number;
}

export function collectSystemMetrics(): SystemMetrics {
  const memUsed = process.memoryUsage();
  return {
    cpuUsage: os.loadavg()[0] ?? 0,
    memUsedMb: Math.round(memUsed.rss / 1024 / 1024),
    memTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    loadAvg1m: os.loadavg()[0] ?? 0,
    uptime: process.uptime(),
    heapUsedMb: memUsed.heapUsed / 1024 / 1024,
    arrayBuffersMb: (memUsed.arrayBuffers ?? 0) / 1024 / 1024,
    externalMb: memUsed.external / 1024 / 1024,
  };
}

export function systemMetricsToPrometheus(metrics: SystemMetrics): string {
  return [
    `ninja_proxy_cpu_load ${metrics.cpuUsage}`,
    `ninja_proxy_memory_used_mb ${metrics.memUsedMb}`,
    `ninja_proxy_memory_total_mb ${metrics.memTotalMb}`,
    `ninja_proxy_uptime_seconds ${metrics.uptime}`,
    `ninja_proxy_heap_used_mb ${metrics.heapUsedMb}`,
    `ninja_proxy_array_buffers_mb ${metrics.arrayBuffersMb}`,
    `ninja_proxy_external_mb ${metrics.externalMb}`,
  ].join('\n') + '\n';
}
