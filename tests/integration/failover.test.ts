import { test } from 'node:test';
import assert from 'node:assert';
import { LoadBalancer } from '../../src/balancer/core/load-balancer.js';

test('Upstream failover integration - circuit breaker tripping', () => {
  const lb = new LoadBalancer({
    strategy: 'weighted-round-robin',
    upstreams: [
      { id: 'upstream-1', url: 'http://localhost:9001', weight: 1 },
      { id: 'upstream-2', url: 'http://localhost:9002', weight: 1 }
    ],
    failureThreshold: 2,
    recoveryTimeMs: 1000
  });

  const healthy = new Set(['upstream-1', 'upstream-2']);

  // Record failures for upstream-1 to trigger circuit breaker open state
  lb.recordFailure('upstream-1');
  lb.recordFailure('upstream-1');

  // Verify it only route requests to upstream-2
  for (let i = 0; i < 5; i++) {
    const next = lb.pickFiltered(healthy, '127.0.0.1', new Set());
    assert.strictEqual(next, 'upstream-2');
  }
});
