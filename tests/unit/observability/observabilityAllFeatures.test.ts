import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetricsRegistry } from "../../../src/observability/metrics/prometheus.exporter.js";
import { Histogram } from "../../../src/observability/metrics/histogram.registry.js";
import { tenantLogStreamer } from "../../../src/observability/logger/tenant-log.streamer.js";
import { logger } from "../../../src/observability/logger/logger.js";

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

test("Observability 3: Tenant Log Streamer Queueing & Webhook Endpoint Mapping", async () => {
  let webhookReceived = false;
  const webhookServer = http.createServer((req, res) => {
    webhookReceived = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });

  await new Promise<void>((r) => webhookServer.listen(0, r));
  const port = (webhookServer.address() as any).port;

  try {
    tenantLogStreamer.configure([{ tenantId: "acme-corp", destination: `http://127.0.0.1:${port}/webhook` }]);

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

    // Explicitly flush to dispatch log immediately without waiting for interval
    await tenantLogStreamer.flush();
    assert.strictEqual(webhookReceived, true);
  } finally {
    tenantLogStreamer.stop();
    await new Promise<void>((r) => webhookServer.close(() => r()));
  }
});

test("Observability 4: Logger.flushAll() guarantees every queued access-log write survives a process.exit()-style shutdown", async () => {
  // Writing many lines then exiting immediately (no event-loop turn in between) can lose
  // every single one of them -- confirmed directly: fs.createWriteStream({flags:"a"}).write()
  // queues the chunk asynchronously, and process.exit() terminates before that chunk ever
  // reaches the fd if nothing awaits completion first. flushAll() must close this gap.
  const logPath = path.join(os.tmpdir(), `ninja-logger-flush-test-${Date.now()}.log`);
  try {
    const LINES = 2000;
    // Fire every write without awaiting in between (mirrors the real request-handling path,
    // where writeAccessLog is called fire-and-forget on every response) so nothing here gives
    // the stream extra event-loop turns to flush on its own -- only flushAll() should do that.
    const writes: Promise<boolean>[] = [];
    for (let i = 0; i < LINES; i++) {
      writes.push(logger.writeAccessLog(logPath, "127.0.0.1", "GET", `/line/${i}`, 200, 0, 1.2, "-"));
    }
    await Promise.all(writes);
    await logger.flushAll();
    const written = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    assert.strictEqual(written.length, LINES, `expected ${LINES} access-log lines to survive flushAll(), got ${written.length}`);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});
