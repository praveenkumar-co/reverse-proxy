import { test } from "node:test";
import assert from "node:assert";
import { createLoadBalancer } from "../../../src/balancer/index.js";
import { registry } from "../../../src/discovery/registry/dynamic.registry.js";

const healthy = new Set(["node-a", "node-b"]);

test("Strategy 1: Round Robin", () => {
  const lb = createLoadBalancer({
    strategy: "round-robin",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  assert.strictEqual(lb.pickFiltered(healthy), "node-a");
  assert.strictEqual(lb.pickFiltered(healthy), "node-b");
  assert.strictEqual(lb.pickFiltered(healthy), "node-a");
});

test("Strategy 2: Weighted Round Robin", () => {
  const lb = createLoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [{ id: "node-a", weight: 3 }, { id: "node-b", weight: 1 }],
  });
  const picks: Record<string, number> = { "node-a": 0, "node-b": 0 };
  for (let i = 0; i < 40; i++) {
    const pick = lb.pickFiltered(healthy);
    if (pick) picks[pick] = (picks[pick] ?? 0) + 1;
  }
  assert.strictEqual(picks["node-a"], 30);
  assert.strictEqual(picks["node-b"], 10);
});

test("Strategy 3: Least Connections", () => {
  const lb = createLoadBalancer({
    strategy: "least-connections",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  lb.incrementConnection("node-a");
  lb.incrementConnection("node-a");
  const pick = lb.pickFiltered(healthy);
  assert.strictEqual(pick, "node-b");
});

test("Strategy 4: Weighted Least Connections", () => {
  const lb = createLoadBalancer({
    strategy: "weighted-least-connections",
    upstreams: [{ id: "node-a", weight: 2 }, { id: "node-b", weight: 1 }],
  });
  lb.incrementConnection("node-a");
  lb.incrementConnection("node-b");
  const pick = lb.pickFiltered(healthy);
  assert.strictEqual(pick, "node-a"); // 1/2 < 1/1
});

test("Strategy 5: Least Response Time (EWMA)", () => {
  const lb = createLoadBalancer({
    strategy: "least-response-time",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  lb.recordSuccess("node-a", 100);
  lb.recordSuccess("node-b", 10);
  const pick = lb.pickFiltered(healthy);
  assert.strictEqual(pick, "node-b");
});

test("Strategy 6: Power of Two Choices (P2C)", () => {
  const lb = createLoadBalancer({
    strategy: "power-of-two",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  lb.incrementConnection("node-a");
  lb.incrementConnection("node-a");
  const pick = lb.pickFiltered(healthy);
  assert.strictEqual(pick, "node-b");
});

test("Strategy 7: Consistent Hashing", () => {
  const lb = createLoadBalancer({
    strategy: "consistent-hashing",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  const pick1 = lb.pickFiltered(healthy, "192.168.1.50");
  const pick2 = lb.pickFiltered(healthy, "192.168.1.50");
  assert.strictEqual(pick1, pick2);
});

test("Strategy 8: IP Hash", () => {
  const lb = createLoadBalancer({
    strategy: "ip-hash",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  const pick1 = lb.pickFiltered(healthy, "10.0.0.5");
  const pick2 = lb.pickFiltered(healthy, "10.0.0.5");
  assert.strictEqual(pick1, pick2);
});

test("Strategy 9: Adaptive WRR", () => {
  const lb = createLoadBalancer({
    strategy: "adaptive-wrr",
    upstreams: [{ id: "node-a", weight: 10 }, { id: "node-b", weight: 10 }],
  });
  for (let i = 0; i < 10; i++) {
    lb.recordSuccess("node-a", 5000);
    lb.recordSuccess("node-b", 5);
  }
  const picks: Record<string, number> = { "node-a": 0, "node-b": 0 };
  for (let i = 0; i < 50; i++) {
    const pick = lb.pickFiltered(healthy);
    if (pick) picks[pick] = (picks[pick] ?? 0) + 1;
  }
  assert.ok((picks["node-b"] ?? 0) > (picks["node-a"] ?? 0));
});

test("Strategy 10: Resource-Based (Telemetry)", () => {
  const lb = createLoadBalancer({
    strategy: "resource-based",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  registry.register({ id: "node-a", url: "http://node-a", metadata: { cpu: "0.9", memory: "0.9" } });
  registry.register({ id: "node-b", url: "http://node-b", metadata: { cpu: "0.1", memory: "0.1" } });
  const pick = lb.pickFiltered(healthy);
  assert.strictEqual(pick, "node-b");
});

test("Strategy 11: Random Strategy", () => {
  const lb = createLoadBalancer({
    strategy: "random",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
  });
  const pick = lb.pickFiltered(healthy);
  assert.ok(pick === "node-a" || pick === "node-b");
});

test("Strategy 12: Sticky Sessions (Cookie Affinity)", () => {
  const lb = createLoadBalancer({
    strategy: "sticky-sessions",
    upstreams: [{ id: "node-a" }, { id: "node-b" }],
    stickyCookieName: "NINJA_ROUTE",
  });
  const pick = lb.pickFiltered(healthy, "127.0.0.1", new Set(), "NINJA_ROUTE=node-b");
  assert.strictEqual(pick, "node-b");
});
