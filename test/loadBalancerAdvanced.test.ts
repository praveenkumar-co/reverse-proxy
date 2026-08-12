import { test } from "node:test";
import assert from "node:assert";
import { LoadBalancer } from "../src/services/load-balancer.js";
import { RateLimiter } from "../src/middleware/rate-limiter.js";
import { registry } from "../src/services/registry.js";

// ─── RATE LIMITER TESTS ──────────────────────────────────────────────────────

test("RateLimiter - Fixed Window", () => {
  const limiter = new RateLimiter({
    windowMs: 100,
    maxRequests: 2,
    algorithm: "fixed-window"
  });

  const ip = "1.1.1.1";
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), false); // Rate limited
});

test("RateLimiter - Sliding Window", () => {
  const limiter = new RateLimiter({
    windowMs: 100,
    maxRequests: 2,
    algorithm: "sliding-window"
  });

  const ip = "2.2.2.2";
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), false); // rate limited
});

test("RateLimiter - Token Bucket", async () => {
  const limiter = new RateLimiter({
    windowMs: 100,
    maxRequests: 5,
    algorithm: "token-bucket"
  });

  const ip = "3.3.3.3";
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), true);
  assert.strictEqual(limiter.isAllowed(ip), false); // Empty bucket
});


// ─── LOAD BALANCER TESTS ──────────────────────────────────────────────────────

test("LoadBalancer - Unweighted Round Robin", () => {
  const lb = new LoadBalancer({
    strategy: "round-robin",
    upstreams: [
      { id: "srv-a", weight: 10 }, // weight ignored
      { id: "srv-b", weight: 1 }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);
  assert.strictEqual(lb.pickFiltered(healthy), "srv-a");
  assert.strictEqual(lb.pickFiltered(healthy), "srv-b");
  assert.strictEqual(lb.pickFiltered(healthy), "srv-a");
});

test("LoadBalancer - Weighted Least Connections", () => {
  const lb = new LoadBalancer({
    strategy: "weighted-least-connections",
    upstreams: [
      { id: "srv-a", weight: 2 },
      { id: "srv-b", weight: 1 }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  // Increment active connections manually on srv-b
  const pickedB = lb.pickFiltered(healthy, undefined, new Set(["srv-a"])); 
  assert.strictEqual(pickedB, "srv-b"); // active connections: srv-a=0, srv-b=1

  // srv-a: activeConnections/weight = 0/2 = 0
  // srv-b: activeConnections/weight = 1/1 = 1
  // srv-a should be chosen
  const picked = lb.pickFiltered(healthy);
  assert.strictEqual(picked, "srv-a");
});

test("LoadBalancer - Least Response Time", () => {
  const lb = new LoadBalancer({
    strategy: "least-response-time",
    upstreams: [
      { id: "srv-a" },
      { id: "srv-b" }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  // Record mock response latencies (latency, bytes)
  lb.recordSuccess("srv-a", 100); // srv-a EWMA latency is ~100ms
  lb.recordSuccess("srv-b", 20);  // srv-b EWMA latency is ~20ms

  const picked = lb.pickFiltered(healthy);
  assert.strictEqual(picked, "srv-b");
});

test("LoadBalancer - Consistent Hashing", () => {
  const lb = new LoadBalancer({
    strategy: "consistent-hashing",
    upstreams: [
      { id: "srv-a" },
      { id: "srv-b" }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  const pick1 = lb.pickFiltered(healthy, "192.168.1.10");
  const pick2 = lb.pickFiltered(healthy, "192.168.1.10");
  const pick3 = lb.pickFiltered(healthy, "192.168.1.10");

  // Consistent hashing maps same IP to same server consistently
  assert.strictEqual(pick1, pick2);
  assert.strictEqual(pick2, pick3);
});

test("LoadBalancer - Least Bandwidth", () => {
  const lb = new LoadBalancer({
    strategy: "least-bandwidth",
    upstreams: [
      { id: "srv-a" },
      { id: "srv-b" }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  lb.recordSuccess("srv-a", 10, 5000); // 5000 bytes processed
  lb.recordSuccess("srv-b", 10, 100);  // 100 bytes processed

  const picked = lb.pickFiltered(healthy);
  assert.strictEqual(picked, "srv-b");
});

test("LoadBalancer - Resource-Based", () => {
  const lb = new LoadBalancer({
    strategy: "resource-based",
    upstreams: [
      { id: "srv-a" },
      { id: "srv-b" }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  // Register telemetry in service registry
  registry.register({ id: "srv-a", url: "http://srv-a", metadata: { cpu: "0.8", memory: "0.9" } });
  registry.register({ id: "srv-b", url: "http://srv-b", metadata: { cpu: "0.1", memory: "0.2" } });

  const picked = lb.pickFiltered(healthy);
  assert.strictEqual(picked, "srv-b"); // Less busy
});

test("LoadBalancer - Sticky Sessions (Session Affinity)", () => {
  const lb = new LoadBalancer({
    strategy: "sticky-sessions",
    upstreams: [
      { id: "srv-a" },
      { id: "srv-b" }
    ]
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  // Pick with sticky cookie
  const pick = lb.pickFiltered(healthy, "1.2.3.4", new Set(), "NINJA_ROUTE=srv-b");
  assert.strictEqual(pick, "srv-b");
});
