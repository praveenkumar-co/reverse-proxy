import { test } from "node:test";
import assert from "node:assert";
import { ServiceRegistry } from "../../../src/discovery/registry/dynamic.registry.js";
import { checkUpstream } from "../../../src/discovery/health/active.probe.js";
import { PassiveProbe } from "../../../src/discovery/health/passive.probe.js";
import http from "http";

test("Discovery 1: ServiceRegistry Lifecycle (Register, Heartbeat, Deregister)", () => {
  const reg = new ServiceRegistry({ heartbeatTimeoutMs: 5000 });
  reg.register({ id: "s1", url: "http://127.0.0.1:9000" });

  assert.strictEqual(reg.get("s1")?.url, "http://127.0.0.1:9000");
  assert.strictEqual(reg.heartbeat("s1"), true);
  assert.strictEqual(reg.getAll().length, 1);

  assert.strictEqual(reg.deregister("s1"), true);
  assert.strictEqual(reg.get("s1"), undefined);
});

test("Discovery 2: Passive Probe Listener & Event Recording", () => {
  const probe = new PassiveProbe();
  let fired = false;
  probe.onEvent((evt) => {
    if (evt.upstreamId === "node-err" && evt.statusCode === 502) {
      fired = true;
    }
  });

  probe.record({ upstreamId: "node-err", statusCode: 502, latencyMs: 300 });
  assert.strictEqual(fired, true);
});

test("Discovery 3: Active Probe Upstream Ping (200 OK vs 500 FAIL)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("OK");
    } else {
      res.writeHead(500);
      res.end("FAIL");
    }
  });

  await new Promise<void>(r => server.listen(9870, r));

  try {
    const isOk = await checkUpstream({ id: "node1", url: "http://127.0.0.1:9870", healthPath: "/health" });
    assert.strictEqual(isOk, true);

    const isFail = await checkUpstream({ id: "node1", url: "http://127.0.0.1:9870", healthPath: "/bad" });
    assert.strictEqual(isFail, false);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});
