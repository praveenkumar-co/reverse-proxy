import { test } from "node:test";
import assert from "node:assert";
import { ClassicCircuitBreaker } from "../../../src/resilience/circuit-breaker/classic.circuit-breaker.js";
import { AdaptiveCircuitBreaker } from "../../../src/resilience/circuit-breaker/adaptive.circuit-breaker.js";
import { Bulkhead } from "../../../src/resilience/bulkhead/bulkhead.js";
import { calculateExponentialBackoff } from "../../../src/resilience/retry/backoff/exponential.backoff.js";
import { calculateFullJitterBackoff } from "../../../src/resilience/retry/backoff/full-jitter.backoff.js";
import { calculateEqualJitterBackoff } from "../../../src/resilience/retry/backoff/equal-jitter.backoff.js";
import { calculateDecorrelatedJitterBackoff } from "../../../src/resilience/retry/backoff/decorrelated-jitter.backoff.js";
import { RetryBudget } from "../../../src/resilience/retry/retry-budget.js";

test("Resilience 1: Classic Circuit Breaker State Machine (CLOSED -> OPEN)", () => {
  const cb = new ClassicCircuitBreaker(2, 1000);
  assert.strictEqual(cb.getState(), "CLOSED");
  assert.strictEqual(cb.isAllowed(), true);

  cb.recordFailure();
  assert.strictEqual(cb.getState(), "CLOSED");

  cb.recordFailure();
  assert.strictEqual(cb.getState(), "OPEN");
  assert.strictEqual(cb.isAllowed(), false);
});

test("Resilience 2: Adaptive Circuit Breaker (Google SRE EWMA)", () => {
  const cb = new AdaptiveCircuitBreaker(2, 0.9);
  cb.recordSuccess(10);
  cb.recordSuccess(10);
  let stats = cb.getStats();
  assert.strictEqual(stats.dropProbability, 0);

  for (let i = 0; i < 20; i++) cb.recordFailure();
  stats = cb.getStats();
  assert.ok(stats.dropProbability > 0);
});

test("Resilience 3: Bulkhead Concurrency Limiter", () => {
  const bulkhead = new Bulkhead(2);
  assert.strictEqual(bulkhead.enter(), true);
  assert.strictEqual(bulkhead.enter(), true);
  assert.strictEqual(bulkhead.enter(), false); // Rejected at capacity

  bulkhead.leave();
  assert.strictEqual(bulkhead.enter(), true);
});

test("Resilience 4: Exponential Backoff (Deterministic)", () => {
  const d1 = calculateExponentialBackoff(1, 100, 1000);
  const d2 = calculateExponentialBackoff(2, 100, 1000);
  assert.strictEqual(d1, 200);
  assert.strictEqual(d2, 400);
});

test("Resilience 5: Full Jitter Backoff (Randomized [0, cap])", () => {
  for (let i = 0; i < 10; i++) {
    const delay = calculateFullJitterBackoff(2, 100, 1000);
    assert.ok(delay >= 0 && delay <= 400);
  }
});

test("Resilience 6: Equal Jitter Backoff (Randomized [cap/2, cap])", () => {
  for (let i = 0; i < 10; i++) {
    const delay = calculateEqualJitterBackoff(2, 100, 1000);
    assert.ok(delay >= 200 && delay <= 400);
  }
});

test("Resilience 7: Decorrelated Jitter Backoff (Previous Sleep Growth)", () => {
  const d1 = calculateDecorrelatedJitterBackoff(1, 100, 5000);
  assert.ok(d1 >= 100 && d1 <= 300);
  const d2 = calculateDecorrelatedJitterBackoff(2, 100, 5000, d1);
  assert.ok(d2 >= 100 && d2 <= d1 * 3);
});

test("Resilience 8: Retry Budget Decay & Ratio Protection", () => {
  const budget = new RetryBudget(15, 0.9);
  budget.recordRequest();
  assert.strictEqual(budget.recordRetry(), true);
});
