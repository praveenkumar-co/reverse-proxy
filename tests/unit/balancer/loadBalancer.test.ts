import { test } from "node:test";
import assert from "node:assert";
import { LoadBalancer } from "../../../src/balancer/core/load-balancer.js";

// Test 1: Weighted Round-Robin distribution
test("LoadBalancer - Weighted Round Robin", () => {
  const lb = new LoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [
      { id: "backend-a", weight: 3 },
      { id: "backend-b", weight: 1 }
    ]
  });

  const healthy = new Set(["backend-a", "backend-b"]);
  const picks: Record<string, number> = { "backend-a": 0, "backend-b": 0 };

  for (let i = 0; i < 40; i++) {
    const pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
    if (pick) {
      picks[pick] = (picks[pick] ?? 0) + 1;
      lb.recordSuccess(pick);
    }
  }

  assert.strictEqual(picks["backend-a"], 30);
  assert.strictEqual(picks["backend-b"], 10);
});

// Test 2: Circuit Breaker isolating failing backends
test("LoadBalancer - Circuit Breaker Tripping", () => {
  const lb = new LoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [
      { id: "backend-a", weight: 1 },
      { id: "backend-b", weight: 1 }
    ],
    failureThreshold: 2,
    recoveryTimeMs: 15000
  });

  const healthy = new Set(["backend-a", "backend-b"]);

  lb.recordFailure("backend-a");
  lb.recordFailure("backend-a");

  for (let i = 0; i < 10; i++) {
    const pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
    assert.strictEqual(pick, "backend-b");
    if (pick) lb.recordSuccess(pick);
  }
});

// Test 3: Upstream Retry Filtering
test("LoadBalancer - Retry Filter exclusion", () => {
  const lb = new LoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [
      { id: "backend-a", weight: 1 },
      { id: "backend-b", weight: 1 }
    ]
  });

  const healthy = new Set(["backend-a", "backend-b"]);
  const attempted = new Set(["backend-a"]);

  const pick = lb.pickFiltered(healthy, "127.0.0.1", attempted);
  assert.strictEqual(pick, "backend-b");
});

// Test 4: Circuit Breaker Time Recovery (HALF-OPEN Probe)
test("LoadBalancer - Circuit Breaker Time Recovery", async () => {
  const lb = new LoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [
      { id: "backend-a", weight: 1 },
      { id: "backend-b", weight: 1 }
    ],
    failureThreshold: 2,
    recoveryTimeMs: 50 // Short recovery time for instant testing
  });

  const healthy = new Set(["backend-a", "backend-b"]);

  // 1. Trip backend-a (CLOSED -> OPEN)
  lb.recordFailure("backend-a");
  lb.recordFailure("backend-a");

  // Verify backend-a is isolated
  let pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
  assert.strictEqual(pick, "backend-b");
  if (pick) lb.recordSuccess(pick);

  // 2. Wait for recoveryTimeMs (50ms) to elapse
  await new Promise((resolve) => setTimeout(resolve, 60));

  // 3. Probing (OPEN -> HALF_OPEN)
  // Since recoveryTimeMs elapsed, backend-a should be picked again for probing
  pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
  assert.strictEqual(pick, "backend-a");

  // 4. Success closes the circuit (HALF_OPEN -> CLOSED)
  if (pick) lb.recordSuccess(pick);

  // Verify backend-a is fully restored and gets routed to again
  pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
  assert.strictEqual(pick, "backend-b"); // WRR alternates to b
});
