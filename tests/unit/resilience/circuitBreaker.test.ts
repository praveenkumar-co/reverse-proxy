import { test } from "node:test";
import assert from "node:assert";
import { ClassicCircuitBreaker } from "../../../src/resilience/circuit-breaker/classic.circuit-breaker.js";
import { AdaptiveCircuitBreaker } from "../../../src/resilience/circuit-breaker/adaptive.circuit-breaker.js";
import { calculateExponentialBackoff } from "../../../src/resilience/retry/backoff/exponential.backoff.js";
import { calculateFullJitterBackoff } from "../../../src/resilience/retry/backoff/full-jitter.backoff.js";
import { calculateEqualJitterBackoff } from "../../../src/resilience/retry/backoff/equal-jitter.backoff.js";
import { calculateDecorrelatedJitterBackoff } from "../../../src/resilience/retry/backoff/decorrelated-jitter.backoff.js";
import { Bulkhead } from "../../../src/resilience/bulkhead/bulkhead.js";

test("ClassicCircuitBreaker - trips to OPEN after threshold", () => {
  const cb = new ClassicCircuitBreaker(3, 1000);
  assert.strictEqual(cb.getState(), "CLOSED");
  assert.strictEqual(cb.isAllowed(), true);

  cb.recordFailure();
  cb.recordFailure();
  assert.strictEqual(cb.getState(), "CLOSED");

  cb.recordFailure();
  assert.strictEqual(cb.getState(), "OPEN");
  assert.strictEqual(cb.isAllowed(), false);
});

test("AdaptiveCircuitBreaker - calculates stats and decay", () => {
  const cb = new AdaptiveCircuitBreaker(2, 0.9);
  cb.recordSuccess(10);
  cb.recordSuccess(10);

  let stats = cb.getStats();
  assert.ok(stats.requests > 0);
  assert.ok(stats.accepts > 0);
  assert.strictEqual(stats.dropProbability, 0);

  for (let i = 0; i < 20; i++) {
    cb.recordFailure();
  }
  stats = cb.getStats();
  assert.ok(stats.dropProbability > 0);
});

test("ExponentialBackoff - doubles delay per attempt up to max", () => {
  const delay1 = calculateExponentialBackoff(1, 100, 1000);
  const delay2 = calculateExponentialBackoff(2, 100, 1000);
  const delayMax = calculateExponentialBackoff(10, 100, 1000);

  assert.strictEqual(delay1, 200);
  assert.strictEqual(delay2, 400);
  assert.strictEqual(delayMax, 1000);
});

test("FullJitterBackoff - returns randomized delay within range", () => {
  for (let i = 0; i < 10; i++) {
    const delay = calculateFullJitterBackoff(2, 100, 1000);
    assert.ok(delay >= 0 && delay <= 400);
  }
});

test("EqualJitterBackoff - includes base minimum plus jitter", () => {
  for (let i = 0; i < 10; i++) {
    const delay = calculateEqualJitterBackoff(2, 100, 1000);
    assert.ok(delay >= 200 && delay <= 400);
  }
});

test("DecorrelatedJitterBackoff - relies on previous sleep", () => {
  const delay1 = calculateDecorrelatedJitterBackoff(1, 100, 5000);
  assert.ok(delay1 >= 100 && delay1 <= 300);

  const delay2 = calculateDecorrelatedJitterBackoff(2, 100, 5000, delay1);
  assert.ok(delay2 >= 100 && delay2 <= delay1 * 3);
});

test("Bulkhead - limits max concurrent slots", () => {
  const bulkhead = new Bulkhead(2);
  assert.strictEqual(bulkhead.enter(), true);
  assert.strictEqual(bulkhead.enter(), true);
  assert.strictEqual(bulkhead.enter(), false);

  bulkhead.leave();
  assert.strictEqual(bulkhead.enter(), true);
});
