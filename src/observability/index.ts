// Observability barrel — import anything observability-related from here

export { logger, writeAccessLog } from './logger/logger.js';
export type { LogLevel, LoggerConfig } from './logger/logger.js';

export { MetricsRegistry } from './metrics/prometheus.exporter.js';
export { collectSystemMetrics, systemMetricsToPrometheus } from './metrics/system.metrics.js';
export type { SystemMetrics } from './metrics/system.metrics.js';
export { histogramRegistry, HistogramRegistry, Histogram } from './metrics/histogram.registry.js';
export type { HistogramBucket } from './metrics/histogram.registry.js';

export { tracer } from './tracing/tracer.js';
export type { Span } from './tracing/tracer.js';

export { readinessProbe, ReadinessProbe } from './health/readiness.js';
export type { ReadinessCheck } from './health/readiness.js';
