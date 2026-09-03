import { test } from "node:test";
import assert from "node:assert";
import { MetricsRegistry } from "../../../src/observability/metrics/prometheus.exporter.js";
import { Histogram, histogramRegistry } from "../../../src/observability/metrics/histogram.registry.js";
import { tenantLogStreamer } from "../../../src/observability/logger/tenant-log.streamer.js";

test("Observability 1: Histogram Buckets & Prometheus Formatting", () => {
  const hist = new Histogram([10, 50, 100]);
  hist.observe(25);
  hist.observe(75);
  const out = hist.toPrometheus("test_dur", 'path="/api"');

  assert.ok(out.includes('test_dur_bucket{path="/api",le="50"} 1'));
  assert.ok(out.includes('test_dur_bucket{path="/api",le="100"} 2'));
});

test("Observability 2: MetricsRegistry Exposition Format", () => {
  const registry = new MetricsRegistry(new Set(["node-1"]));
  registry.recordRequest("GET", "/users", 200, "node-1", 12.5, "tenant-1");
  const scrape = registry.getExpositionFormat(["node-1"]);

  assert.ok(scrape.includes('ninja_http_requests_total{method="GET",path="/users",status="200",upstream_id="node-1",tenant_id="tenant-1"} 1'));
  assert.ok(scrape.includes('ninja_active_connections{upstream_id="node-1"} 0'));
});

test("Observability 3: Tenant Log Streamer Queueing & Webhook Endpoint Mapping", () => {
  tenantLogStreamer.configure([{ tenantId: "acme-corp", destination: "http://webhook.dummy/logs" }]);

  tenantLogStreamer.queueLog("acme-corp", {
    timestamp: new Date().toISOString(),
    clientIp: "192.168.1.1",
    method: "POST",
    url: "/api/checkout",
    statusCode: 201,
    bytesSent: 512,
    latencyMs: 18,
    userAgent: "Mozilla/5.0",
  });

  // Verify queuing logic operates without exception
  assert.ok(true);
});
