import { collectSystemMetrics, systemMetricsToPrometheus } from './system.metrics.js';
import { histogramRegistry } from './histogram.registry.js';

export class MetricsRegistry {
  private requestsTotal = new Map<string, number>();
  private activeConnections = new Map<string, number>();
  private cacheOperations = new Map<string, number>();
  private healthyUpstreams: Set<string>;

  constructor(healthyUpstreams: Set<string>) {
    this.healthyUpstreams = healthyUpstreams;
  }

  public recordRequest(
    method: string,
    path: string,
    status: number,
    upstreamId: string,
    durationMs: number,
  ) {
    const cleanPath = path.split("?")[0];
    const labels = `method="${method}",path="${cleanPath}",status="${status}",upstream_id="${upstreamId}"`;
    this.requestsTotal.set(labels, (this.requestsTotal.get(labels) || 0) + 1);

    // Delegate histogram tracking to the shared HistogramRegistry
    const histogramLabel = `method="${method}",path="${cleanPath}",upstream_id="${upstreamId}"`;
    histogramRegistry
      .getOrCreate(`ninja_http_request_duration_ms:${histogramLabel}`)
      .observe(durationMs);
  }

  public recordActiveConnection(upstreamId: string, delta: number) {
    const current = this.activeConnections.get(upstreamId) || 0;
    this.activeConnections.set(upstreamId, Math.max(0, current + delta));
  }

  public recordCacheOp(action: "hit" | "miss") {
    this.cacheOperations.set(
      action,
      (this.cacheOperations.get(action) || 0) + 1,
    );
  }

  public getExpositionFormat(allUpstreamIds: string[]): string {
    let output = "";

    // ── Request counters ────────────────────────────────────────────────────
    output += "# HELP ninja_http_requests_total Total number of HTTP requests processed by the proxy\n";
    output += "# TYPE ninja_http_requests_total counter\n";
    for (const [labels, count] of this.requestsTotal.entries()) {
      output += `ninja_http_requests_total{${labels}} ${count}\n`;
    }
    output += "\n";

    // ── Request duration histograms (via HistogramRegistry) ─────────────────
    output += "# HELP ninja_http_request_duration_ms Request duration in milliseconds\n";
    output += "# TYPE ninja_http_request_duration_ms histogram\n";
    // The histogramRegistry stores histograms keyed by "ninja_http_request_duration_ms:<labels>"
    // Each histogram's toPrometheus() emits _bucket, _sum, _count lines.
    // We iterate via a private accessor exposed through the registry's getOrCreate pattern.
    // Instead of accessing internals, we use a dedicated export method:
    output += histogramRegistry.toPrometheusAll("ninja_http_request_duration_ms");
    output += "\n";

    // ── Active connections ───────────────────────────────────────────────────
    output += "# HELP ninja_active_connections Current number of active connections to the upstream\n";
    output += "# TYPE ninja_active_connections gauge\n";
    for (const upstreamId of allUpstreamIds) {
      const active = this.activeConnections.get(upstreamId) || 0;
      output += `ninja_active_connections{upstream_id="${upstreamId}"} ${active}\n`;
    }
    output += "\n";

    // ── Cache ops ────────────────────────────────────────────────────────────
    output += "# HELP ninja_cache_operations_total Total cache hits/misses\n";
    output += "# TYPE ninja_cache_operations_total counter\n";
    output += `ninja_cache_operations_total{action="hit"} ${this.cacheOperations.get("hit") || 0}\n`;
    output += `ninja_cache_operations_total{action="miss"} ${this.cacheOperations.get("miss") || 0}\n`;
    output += "\n";

    // ── Upstream health ──────────────────────────────────────────────────────
    output += "# HELP ninja_upstream_status Health status of the upstream (1 = UP, 0 = DOWN)\n";
    output += "# TYPE ninja_upstream_status gauge\n";
    for (const upstreamId of allUpstreamIds) {
      const isUp = this.healthyUpstreams.has(upstreamId) ? 1 : 0;
      output += `ninja_upstream_status{upstream_id="${upstreamId}"} ${isUp}\n`;
    }
    output += "\n";

    // ── System metrics ───────────────────────────────────────────────────────
    output += "# HELP ninja_system_metrics System-level resource metrics\n";
    output += "# TYPE ninja_system_metrics gauge\n";
    output += systemMetricsToPrometheus(collectSystemMetrics());

    return output;
  }
}
