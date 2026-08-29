import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createLoadBalancer } from '../../../src/balancer/index.js';
import { circuitBreakerManager } from '../../../src/resilience/circuit-breaker/circuit-breaker.manager.js';

beforeEach(() => {
  circuitBreakerManager.clear();
});
test("LoadBalancer - Weighted Round Robin", () => {
  const lb = createLoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [
      { id: "backend-a", weight: 3 },
      { id: "backend-b", weight: 1 }
    ]
  });
  const healthy = new Set(["backend-a", "backend-b"]);
  const picks: Record<string, number> = { "backend-a": 0, "backend-b": 0 };
  for(let i = 0; i < 40; i++){
    const pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
    if(pick){
      picks[pick] = (picks[pick] ?? 0) + 1;
      lb.recordSuccess(pick);
    }
  }
  assert.strictEqual(picks["backend-a"], 30);
  assert.strictEqual(picks["backend-b"], 10);
});
test("LoadBalancer - Circuit Breaker Tripping", () => {
  const lb = createLoadBalancer({
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
  for(let i = 0; i < 10; i++){
    const pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
    assert.strictEqual(pick, "backend-b");
    if (pick) lb.recordSuccess(pick);
  }
});
test("LoadBalancer - Retry Filter exclusion", () => {
  const lb = createLoadBalancer({
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
test("LoadBalancer - Circuit Breaker Time Recovery", async () => {
  const lb = createLoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [
      { id: "backend-a", weight: 1 },
      { id: "backend-b", weight: 1 }
    ],
    failureThreshold: 2,
    recoveryTimeMs: 50
  });
  const healthy = new Set(["backend-a", "backend-b"]);
  lb.recordFailure("backend-a");
  lb.recordFailure("backend-a");
  let pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
  assert.strictEqual(pick, "backend-b");
  if(pick) lb.recordSuccess(pick);
  await new Promise((resolve) => setTimeout(resolve, 60));
  pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
  assert.strictEqual(pick, "backend-a");
  if(pick) lb.recordSuccess(pick);
  pick = lb.pickFiltered(healthy, "127.0.0.1", new Set());
  assert.strictEqual(pick, "backend-b");
});
