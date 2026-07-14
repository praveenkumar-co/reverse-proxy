export class MetricsRegistry {
  private requestsTotal = new Map<string, number>();
  private requestDurationSum = new Map<string, number>();
  private requestDurationCount = new Map<string, number>();
  private activeConnections = new Map<string, number>();
  private cacheOperations = new Map<string, number>();
  private healthyUpstreams: Set<string>;

  constructor(healthyUpstreams: Set<string>) {
    this.healthyUpstreams = healthyUpstreams;
  }

  public recordRequest(method: string, path: string, status: number, upstreamId: string, durationMs: number) {
    const cleanPath = path.split("?")[0]; // remove query parameters
    const key = `method="${method}",path="${cleanPath}",status="${status}",upstream_id="${upstreamId}"`;
    this.requestsTotal.set(key, (this.requestsTotal.get(key) || 0) + 1);

    const durationKey = `method="${method}",path="${cleanPath}",upstream_id="${upstreamId}"`;
    const durationSeconds = durationMs / 1000;
    this.requestDurationSum.set(durationKey, (this.requestDurationSum.get(durationKey) || 0) + durationSeconds);
    this.requestDurationCount.set(durationKey, (this.requestDurationCount.get(durationKey) || 0) + 1);
  }

  public recordActiveConnection(upstreamId: string, delta: number) {
    const current = this.activeConnections.get(upstreamId) || 0;
    this.activeConnections.set(upstreamId, Math.max(0, current + delta));
  }

  public recordCacheOp(action: "hit" | "miss") {
    this.cacheOperations.set(action, (this.cacheOperations.get(action) || 0) + 1);
  }

  public getExpositionFormat(allUpstreamIds: string[]): string {
    let output = "";

    output += "# HELP ninja_http_requests_total Total number of HTTP requests processed by the proxy\n";
    output += "# TYPE ninja_http_requests_total counter\n";
    for (const [labels, count] of this.requestsTotal.entries()) {
      output += `ninja_http_requests_total{${labels}} ${count}\n`;
    }
    output += "\n";
    output += "# HELP ninja_http_request_duration_seconds_sum Sum of request durations in seconds\n";
    output += "# TYPE ninja_http_request_duration_seconds_sum counter\n";
    for (const [labels, sum] of this.requestDurationSum.entries()) {
      output += `ninja_http_request_duration_seconds_sum{${labels}} ${sum.toFixed(6)}\n`;
    }
    output += "\n";
    output += "# HELP ninja_http_request_duration_seconds_count Count of requests for duration tracking\n";
    output += "# TYPE ninja_http_request_duration_seconds_count counter\n";
    for (const [labels, count] of this.requestDurationCount.entries()) {
      output += `ninja_http_request_duration_seconds_count{${labels}} ${count}\n`;
    }
    output += "\n";
    output += "# HELP ninja_active_connections Current number of active connections to the upstream\n";
    output += "# TYPE ninja_active_connections gauge\n";
    for (const upstreamId of allUpstreamIds) {
      const active = this.activeConnections.get(upstreamId) || 0;
      output += `ninja_active_connections{upstream_id="${upstreamId}"} ${active}\n`;
    }
    output += "\n";
    output += "# HELP ninja_cache_operations_total Total cache hits/misses\n";
    output += "# TYPE ninja_cache_operations_total counter\n";
    output += `ninja_cache_operations_total{action="hit"} ${this.cacheOperations.get("hit") || 0}\n`;
    output += `ninja_cache_operations_total{action="miss"} ${this.cacheOperations.get("miss") || 0}\n`;
    output += "\n";

    // 6. Upstream status
    output += "# HELP ninja_upstream_status Health status of the upstream (1 = UP, 0 = DOWN)\n";
    output += "# TYPE ninja_upstream_status gauge\n";
    for (const upstreamId of allUpstreamIds) {
      const isUp = this.healthyUpstreams.has(upstreamId) ? 1 : 0;
      output += `ninja_upstream_status{upstream_id="${upstreamId}"} ${isUp}\n`;
    }
    output += "\n";

    return output;
  }
}
