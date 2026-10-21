import { collectSystemMetrics, systemMetricsToPrometheus } from './system.metrics.js';
import { histogramRegistry } from './histogram.registry.js';

const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collapses high-cardinality path segments (numeric IDs, UUIDs) and strips the query string,
 * so metric labels stay bounded regardless of what a client sends. Call sites should prefer
 * passing the matched route-rule's configured path (e.g. `pathRule.path`) instead of the raw
 * request path in the first place — this is a defense-in-depth backstop for whatever reaches
 * here, not a substitute for that.
 */
export function normalizeMetricPath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  const segments = withoutQuery.split('/').map((segment) => {
    if (segment.length === 0) return segment;
    if (NUMERIC_SEGMENT.test(segment) || UUID_SEGMENT.test(segment)) return ':id';
    return segment;
  });
  return segments.join('/');
}

export class MetricsRegistry {
  private requestsTotal = new Map<string, number>();
  private activeConnections = new Map<string, number>();
  private cacheOperations = new Map<string, number>();
  private healthyUpstreams: Set<string>;

  constructor(healthyUpstreams: Set<string>){
    this.healthyUpstreams = healthyUpstreams;
  }
  public recordRequest(
    method: string,
    path: string,
    status: number,
    upstreamId: string,
    durationMs: number,
    tenantId = "none",
  ){
    const cleanPath = normalizeMetricPath(path);
    const labels = `method="${method}",path="${cleanPath}",status="${status}",upstream_id="${upstreamId}",tenant_id="${tenantId}"`;
    this.requestsTotal.set(labels, (this.requestsTotal.get(labels) || 0) + 1);
    const histogramLabel = `method="${method}",path="${cleanPath}",upstream_id="${upstreamId}",tenant_id="${tenantId}"`;
    histogramRegistry
      .getOrCreate(`ninja_http_request_duration_ms:${histogramLabel}`)
      .observe(durationMs);
  }
  public recordActiveConnection(upstreamId: string, delta: number){
    const current = this.activeConnections.get(upstreamId) || 0;
    this.activeConnections.set(upstreamId, Math.max(0, current + delta));
  }
  public recordCacheOp(action: "hit" | "miss"){
    this.cacheOperations.set(
      action,
      (this.cacheOperations.get(action) || 0) + 1,
    );
  }
  public getSnapshot(){
    return {
      requestsTotal: Array.from(this.requestsTotal.entries()),
      activeConnections: Array.from(this.activeConnections.entries()),
      cacheOperations: Array.from(this.cacheOperations.entries()),
      histograms: histogramRegistry.getSnapshotAll(),
    };
  }
  public mergeSnapshot(snap: any){
    if(!snap) return;
    if(snap.requestsTotal){
      for(const [labels, count] of snap.requestsTotal){
        this.requestsTotal.set(labels, (this.requestsTotal.get(labels) || 0) + count);
      }
    }
    if(snap.activeConnections){
      for(const [upstreamId, count] of snap.activeConnections){
        this.activeConnections.set(upstreamId, (this.activeConnections.get(upstreamId) || 0) + count);
      }
    }
    if(snap.cacheOperations){
      for(const [action, count] of snap.cacheOperations){
        this.cacheOperations.set(action, (this.cacheOperations.get(action) || 0) + count);
      }
    }
    if(snap.histograms){
      histogramRegistry.mergeAll(snap.histograms);
    }
  }
  public getExpositionFormat(allUpstreamIds: string[], tenantFilter?: string): string {
    let rawOutput = "";
    rawOutput += "# HELP ninja_http_requests_total Total number of HTTP requests processed by the proxy\n";
    rawOutput += "# TYPE ninja_http_requests_total counter\n";
    for(const [labels, count] of this.requestsTotal.entries()){
      rawOutput += `ninja_http_requests_total{${labels}} ${count}\n`;
    }
    rawOutput += "\n";
    rawOutput += "# HELP ninja_http_request_duration_ms Request duration in milliseconds\n";
    rawOutput += "# TYPE ninja_http_request_duration_ms histogram\n";
    rawOutput += histogramRegistry.toPrometheusAll("ninja_http_request_duration_ms");
    rawOutput += "\n";
    rawOutput += "# HELP ninja_active_connections Current number of active connections to the upstream\n";
    rawOutput += "# TYPE ninja_active_connections gauge\n";
    for (const upstreamId of allUpstreamIds){
      const active = this.activeConnections.get(upstreamId) || 0;
      rawOutput += `ninja_active_connections{upstream_id="${upstreamId}"} ${active}\n`;
    }
    rawOutput += "\n";
    rawOutput += "# HELP ninja_cache_operations_total Total cache hits/misses\n";
    rawOutput += "# TYPE ninja_cache_operations_total counter\n";
    rawOutput += `ninja_cache_operations_total{action="hit"} ${this.cacheOperations.get("hit") || 0}\n`;
    rawOutput += `ninja_cache_operations_total{action="miss"} ${this.cacheOperations.get("miss") || 0}\n`;
    rawOutput += "\n";
    rawOutput += "# HELP ninja_upstream_status Health status of the upstream (1 = UP, 0 = DOWN)\n";
    rawOutput += "# TYPE ninja_upstream_status gauge\n";
    for (const upstreamId of allUpstreamIds){
      const isUp = this.healthyUpstreams.has(upstreamId) ? 1 : 0;
      rawOutput += `ninja_upstream_status{upstream_id="${upstreamId}"} ${isUp}\n`;
    }
    rawOutput += "\n";
    rawOutput += "# HELP ninja_system_metrics System-level resource metrics\n";
    rawOutput += "# TYPE ninja_system_metrics gauge\n";
    rawOutput += systemMetricsToPrometheus(collectSystemMetrics());
    if(!tenantFilter){
      return rawOutput;
    }
    const lines = rawOutput.split("\n");
    const filteredLines = lines.filter((line) => {
      if(line.startsWith("#") || !line.trim()) return true;
      const match = line.match(/tenant_id="([^"]+)"/);
      if(match){
        return match[1] === tenantFilter;
      }
      return true ;
    });
    return filteredLines.join("\n");
  }
}
