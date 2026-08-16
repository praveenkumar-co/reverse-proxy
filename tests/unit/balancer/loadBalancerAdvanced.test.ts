import { test } from "node:test";
import assert from "node:assert";
import { LoadBalancer } from "../../../src/services/load-balancer.js";
import { RateLimiter } from "../../../src/middleware/rate-limiter.js";
import { registry } from "../../../src/services/registry.js";
import { Cache } from "../../../src/middleware/cache.js";

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

test("LoadBalancer - Power of Two Choices (P2C)", () => {
  const lb = new LoadBalancer({
    strategy: "power-of-two",
    upstreams: [
      { id: "srv-a" },
      { id: "srv-b" }
    ],
    failureThreshold: 3,
    recoveryTimeMs: 10000,
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  // Set connections so srv-b is clearly lower load
  lb.incrementConnection("srv-a");
  lb.incrementConnection("srv-a");
  lb.incrementConnection("srv-b");

  // Pick should choose srv-b
  const picked = lb.pickFiltered(healthy);
  assert.strictEqual(picked, "srv-b");
});

test("LoadBalancer - Adaptive Weighted Round Robin", () => {
  const lb = new LoadBalancer({
    strategy: "adaptive-wrr",
    upstreams: [
      { id: "srv-a", weight: 10 },
      { id: "srv-b", weight: 10 }
    ],
    failureThreshold: 3,
    recoveryTimeMs: 10000,
  });

  const healthy = new Set(["srv-a", "srv-b"]);

  // Record extreme latency on srv-a so its effective weight drops
  for (let i = 0; i < 20; i++) {
    lb.recordSuccess("srv-a", 5000);
    lb.recordSuccess("srv-b", 5);
  }

  // Count distribution over 100 picks
  let countA = 0;
  let countB = 0;
  for (let i = 0; i < 100; i++) {
    const picked = lb.pickFiltered(healthy);
    if (picked === "srv-a") countA++;
    if (picked === "srv-b") countB++;
  }

  // srv-b should receive significantly more traffic
  assert.ok(countB > countA, `B: ${countB}, A: ${countA}`);
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

test("Cache - Debezium Event Parsing (SQL and MongoDB)", async () => {
  const cache = new Cache({
    host: "localhost",
    port: 6379,
    ttlSeconds: 60,
    enabled: true,
    debezium: {
      enabled: true,
      channel: "dbz-test",
      mappings: [
        { table: "items", pathPattern: "/api/items/{id}" }
      ]
    }
  });

  // Mock the invalidate method
  const invalidatedPatterns: string[] = [];
  cache.invalidate = async (pattern: string) => {
    invalidatedPatterns.push(pattern);
  };

  // Test Case 1: SQL update event
  const sqlEvent = JSON.stringify({
    op: "u",
    source: { table: "items" },
    after: { id: 123, name: "New Name" }
  });
  await (cache as any).handleDebeziumEvent(sqlEvent);
  assert.deepStrictEqual(invalidatedPatterns, ["/api/items/123"]);

  // Test Case 2: MongoDB update event (ObjectId representation)
  const mongoEvent = JSON.stringify({
    op: "u",
    source: { collection: "items" },
    after: { _id: { $oid: "60d5ec4b1234567890abcdef" }, name: "New Name" }
  });
  invalidatedPatterns.length = 0; // reset
  await (cache as any).handleDebeziumEvent(mongoEvent);
  assert.deepStrictEqual(invalidatedPatterns, ["/api/items/60d5ec4b1234567890abcdef"]);

  // Test Case 3: Fallback generic cleanups (table not matched in mappings)
  const unknownEvent = JSON.stringify({
    op: "d",
    source: { table: "users" },
    before: { id: 456 }
  });
  invalidatedPatterns.length = 0; // reset
  await (cache as any).handleDebeziumEvent(unknownEvent);
  assert.deepStrictEqual(invalidatedPatterns, ["*users*456*", "*456*"]);
});
