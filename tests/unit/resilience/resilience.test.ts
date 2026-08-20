import { test } from 'node:test';
import assert from 'node:assert';

import { ClassicCircuitBreaker } from '../../../src/resilience/circuit-breaker/classic.circuit-breaker.js';
import { AdaptiveCircuitBreaker } from '../../../src/resilience/circuit-breaker/adaptive.circuit-breaker.js';
import { CircuitBreakerManager } from '../../../src/resilience/circuit-breaker/circuit-breaker.manager.js';
import { Bulkhead } from '../../../src/resilience/bulkhead/bulkhead.js';
import { calculateExponentialBackoff } from '../../../src/resilience/retry/backoff/exponential.backoff.js';
import { calculateFullJitterBackoff } from '../../../src/resilience/retry/backoff/full-jitter.backoff.js';
import { calculateEqualJitterBackoff } from '../../../src/resilience/retry/backoff/equal-jitter.backoff.js';
import { calculateDecorrelatedJitterBackoff } from '../../../src/resilience/retry/backoff/decorrelated-jitter.backoff.js';

// ─── Classic Circuit Breaker ──────────────────────────────────────────────────

test('ClassicCircuitBreaker - starts CLOSED and allows requests', () => {
  const cb = new ClassicCircuitBreaker(3, 30000);
  assert.strictEqual(cb.getState(), 'CLOSED');
  assert.strictEqual(cb.isAllowed(), true);
});

test('ClassicCircuitBreaker - trips to OPEN after failure threshold', () => {
  const cb = new ClassicCircuitBreaker(3, 30000);
  cb.recordFailure();
  cb.recordFailure();
  assert.strictEqual(cb.getState(), 'CLOSED'); // not yet tripped
  cb.recordFailure();
  assert.strictEqual(cb.getState(), 'OPEN');
  assert.strictEqual(cb.isAllowed(), false);
});

test('ClassicCircuitBreaker - recovers to CLOSED after success in HALF_OPEN', () => {
  const cb = new ClassicCircuitBreaker(1, 0); // recoveryTimeMs = 0 to immediately allow HALF_OPEN
  cb.recordFailure();
  assert.strictEqual(cb.getState(), 'OPEN');

  // After recovery timeout (0ms), isAllowed transitions to HALF_OPEN
  assert.strictEqual(cb.isAllowed(), true); // transitions to HALF_OPEN and allows probe
  assert.strictEqual(cb.getState(), 'HALF_OPEN');

  cb.recordSuccess(10);
  assert.strictEqual(cb.getState(), 'CLOSED');
  assert.strictEqual(cb.isAllowed(), true);
});

test('ClassicCircuitBreaker - resets failure count on success', () => {
  const cb = new ClassicCircuitBreaker(3, 30000);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess(5);
  assert.strictEqual(cb.getFailures(), 0);
  assert.strictEqual(cb.getState(), 'CLOSED');
});

// ─── Adaptive Circuit Breaker (SRE Throttling) ───────────────────────────────

test('AdaptiveCircuitBreaker - allows all requests initially', () => {
  const cb = new AdaptiveCircuitBreaker(2, 0.9);
  // With no requests or accepts, drop probability = max(0, (0 - 2*0)/(0+1)) = 0
  assert.strictEqual(cb.isAllowed(), true);
});

test('AdaptiveCircuitBreaker - builds up drop probability on failures', () => {
  const cb = new AdaptiveCircuitBreaker(2, 0.9);
  // Record many failures (no accepts)
  for (let i = 0; i < 20; i++) {
    cb.recordFailure();
  }
  const stats = cb.getStats();
  // Drop probability should be non-zero since accepts << requests
  assert.ok(stats.dropProbability > 0, `Expected drop probability > 0, got ${stats.dropProbability}`);
});

test('AdaptiveCircuitBreaker - reduces drop probability on successes', () => {
  const cb = new AdaptiveCircuitBreaker(2, 0.9);
  for (let i = 0; i < 10; i++) cb.recordFailure();
  const beforeDrop = cb.getStats().dropProbability;

  for (let i = 0; i < 20; i++) cb.recordSuccess(5);
  const afterDrop = cb.getStats().dropProbability;
  assert.ok(afterDrop < beforeDrop, `Drop probability should decrease after successes`);
});

// ─── CircuitBreakerManager ────────────────────────────────────────────────────

test('CircuitBreakerManager - creates and reuses the same instance per id', () => {
  const mgr = new CircuitBreakerManager();
  const cb1 = mgr.getOrCreate('upstream-a', 'classic', { failureThreshold: 2, recoveryTimeMs: 5000 });
  const cb2 = mgr.getOrCreate('upstream-a', 'classic', { failureThreshold: 2, recoveryTimeMs: 5000 });
  assert.strictEqual(cb1, cb2, 'Should return same instance for same id');
});

test('CircuitBreakerManager - creates different instances per id', () => {
  const mgr = new CircuitBreakerManager();
  const cb1 = mgr.getOrCreate('upstream-x', 'classic', { failureThreshold: 2, recoveryTimeMs: 5000 });
  const cb2 = mgr.getOrCreate('upstream-y', 'classic', { failureThreshold: 2, recoveryTimeMs: 5000 });
  assert.notStrictEqual(cb1, cb2, 'Different ids should get different instances');
});

test('CircuitBreakerManager - classic vs adaptive mode', () => {
  const mgr = new CircuitBreakerManager();
  const classic = mgr.getOrCreate('c1', 'classic', { failureThreshold: 3, recoveryTimeMs: 5000 });
  const adaptive = mgr.getOrCreate('a1', 'adaptive', { K: 2, decayFactor: 0.9 });
  assert.ok(classic instanceof ClassicCircuitBreaker);
  assert.ok(adaptive instanceof AdaptiveCircuitBreaker);
});

// ─── Bulkhead ─────────────────────────────────────────────────────────────────

test('Bulkhead - allows up to max concurrent', () => {
  const bh = new Bulkhead(2);
  assert.strictEqual(bh.enter(), true);
  assert.strictEqual(bh.enter(), true);
  assert.strictEqual(bh.getActiveCount(), 2);
});

test('Bulkhead - rejects when at capacity', () => {
  const bh = new Bulkhead(1);
  assert.strictEqual(bh.enter(), true);
  assert.strictEqual(bh.enter(), false); // capacity reached
});

test('Bulkhead - leave releases slot', () => {
  const bh = new Bulkhead(1);
  bh.enter();
  assert.strictEqual(bh.enter(), false);
  bh.leave();
  assert.strictEqual(bh.enter(), true); // slot freed
});

test('Bulkhead - getMaxConcurrent returns configured limit', () => {
  const bh = new Bulkhead(50);
  assert.strictEqual(bh.getMaxConcurrent(), 50);
});

test('Bulkhead - execute wraps async fn with concurrency tracking', async () => {
  const bh = new Bulkhead(2);
  let running = 0;
  const fn = async () => {
    running++;
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return running;
  };
  await Promise.all([bh.execute(fn), bh.execute(fn)]);
  assert.strictEqual(bh.getActiveCount(), 0);
});

test('Bulkhead - execute throws when at capacity', async () => {
  const bh = new Bulkhead(1);
  bh.enter(); // manually consume slot
  await assert.rejects(
    () => bh.execute(async () => 'ok'),
    /Bulkhead capacity reached/
  );
  bh.leave();
});

// ─── Backoff Strategies ───────────────────────────────────────────────────────

test('calculateExponentialBackoff - no randomness, deterministic', () => {
  const delay = calculateExponentialBackoff(2, 100, 5000);
  assert.strictEqual(delay, Math.min(5000, 100 * Math.pow(2, 2)));
});

test('calculateFullJitterBackoff - within [0, cap]', () => {
  for (let i = 0; i < 20; i++) {
    const delay = calculateFullJitterBackoff(3, 100, 5000);
    const cap = Math.min(5000, 100 * Math.pow(2, 3));
    assert.ok(delay >= 0 && delay <= cap, `Full jitter ${delay} out of [0, ${cap}]`);
  }
});

test('calculateEqualJitterBackoff - within [cap/2, cap]', () => {
  for (let i = 0; i < 20; i++) {
    const delay = calculateEqualJitterBackoff(2, 100, 5000);
    const cap = Math.min(5000, 100 * Math.pow(2, 2));
    assert.ok(delay >= cap / 2 && delay <= cap, `Equal jitter ${delay} out of [${cap / 2}, ${cap}]`);
  }
});

test('calculateDecorrelatedJitterBackoff - within [base, max]', () => {
  let prev = 100;
  for (let i = 0; i < 20; i++) {
    const delay = calculateDecorrelatedJitterBackoff(i, 100, 5000, prev);
    assert.ok(delay >= 100 && delay <= 5000, `Decorrelated jitter ${delay} out of [100, 5000]`);
    prev = delay;
  }
});

test('calculateDecorrelatedJitterBackoff - without previous sleep defaults to base', () => {
  const delay = calculateDecorrelatedJitterBackoff(0, 100, 5000);
  assert.ok(delay >= 100 && delay <= 5000);
});
