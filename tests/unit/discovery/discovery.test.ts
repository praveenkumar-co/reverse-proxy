import { test } from "node:test";
import assert from "node:assert";
import { ServiceRegistry } from "../../../src/discovery/registry/dynamic.registry.js";
import { checkUpstream } from "../../../src/discovery/health/active.probe.js";
import http from "http";

test("ServiceRegistry - register, heartbeat, deregister, snapshot", () => {
  const registry = new ServiceRegistry({ heartbeatTimeoutMs: 5000 });
  registry.register({ id: "dyn1", url: "http://127.0.0.1:9001" });

  let node = registry.get("dyn1");
  assert.strictEqual(node?.url, "http://127.0.0.1:9001");

  const hb = registry.heartbeat("dyn1");
  assert.strictEqual(hb, true);

  const snapshot = registry.getAll();
  assert.strictEqual(snapshot.length, 1);
  assert.strictEqual(snapshot[0]?.id, "dyn1");

  const dereg = registry.deregister("dyn1");
  assert.strictEqual(dereg, true);
  assert.strictEqual(registry.get("dyn1"), undefined);
});

test("ActiveProbe - checkUpstream returns true for 200 OK and false for 500", async () => {
  const server = http.createServer((req, res) => {
    if(req.url === "/health") {
      res.writeHead(200);
      res.end("OK");
    }else {
      res.writeHead(500);
      res.end("FAIL");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  try {
    const isHealthy = await checkUpstream({
      id: "test-node",
      url: `http://127.0.0.1:${port}`,
      healthPath: "/health",
    });
    assert.strictEqual(isHealthy, true);

    const isUnhealthy = await checkUpstream({
      id: "test-node",
      url: `http://127.0.0.1:${port}`,
      healthPath: "/bad-path",
    });
    assert.strictEqual(isUnhealthy, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
