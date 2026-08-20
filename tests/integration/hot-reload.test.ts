import { test } from 'node:test';
import assert from 'node:assert';
import { LoadBalancer } from '../../src/balancer/core/load-balancer.js';

test('Hot reload configuration updates', () => {
  let lb = new LoadBalancer({
    strategy: 'round-robin',
    upstreams: [
      { id: 'upstream-1', url: 'http://localhost:9001' }
    ]
  });

  const healthy = new Set(['upstream-1']);
  assert.strictEqual(lb.pickFiltered(healthy, '127.0.0.1', new Set()), 'upstream-1');

  // Simulate configuration reload by creating a new LoadBalancer instance
  lb = new LoadBalancer({
    strategy: 'round-robin',
    upstreams: [
      { id: 'upstream-2', url: 'http://localhost:9002' }
    ]
  });

  const newHealthy = new Set(['upstream-2']);
  assert.strictEqual(lb.pickFiltered(newHealthy, '127.0.0.1', new Set()), 'upstream-2');
});
