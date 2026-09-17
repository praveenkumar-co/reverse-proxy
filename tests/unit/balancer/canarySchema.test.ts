import { test } from 'node:test';
import assert from 'node:assert';
import { canarySchema } from '../../../src/config/schemas/server.schema.js';

test('CanarySchema - valid configuration with defaults', () => {
  const parsed = canarySchema.parse({
    enabled: true,
    canaryUpstream: 'service-v2',
  });

  assert.strictEqual(parsed?.enabled, true);
  assert.strictEqual(parsed?.canaryUpstream, 'service-v2');
  assert.strictEqual(parsed?.weight, 10);
  assert.strictEqual(parsed?.stickyCookieName, 'NINJA_CANARY');
  assert.strictEqual(parsed?.stage, 'canary');
});

test('CanarySchema - valid configuration with paired headers and custom baseline', () => {
  const parsed = canarySchema.parse({
    enabled: true,
    canaryUpstream: 'service-v2',
    baselineUpstream: 'service-v1',
    weight: 25,
    stickyCookieName: 'MY_CANARY_COOKIE',
    headerKey: 'x-beta-test',
    headerValue: 'enabled',
    stage: 'phase-1',
  });

  assert.strictEqual(parsed?.canaryUpstream, 'service-v2');
  assert.strictEqual(parsed?.baselineUpstream, 'service-v1');
  assert.strictEqual(parsed?.weight, 25);
  assert.strictEqual(parsed?.stickyCookieName, 'MY_CANARY_COOKIE');
  assert.strictEqual(parsed?.headerKey, 'x-beta-test');
  assert.strictEqual(parsed?.headerValue, 'enabled');
  assert.strictEqual(parsed?.stage, 'phase-1');
});

test('CanarySchema - fails when headerKey is provided without headerValue', () => {
  assert.throws(() => {
    canarySchema.parse({
      enabled: true,
      canaryUpstream: 'service-v2',
      headerKey: 'x-beta-test',
      // missing headerValue!
    });
  }, /Both 'headerKey' and 'headerValue' must be provided together/);
});

test('CanarySchema - fails when headerValue is provided without headerKey', () => {
  assert.throws(() => {
    canarySchema.parse({
      enabled: true,
      canaryUpstream: 'service-v2',
      headerValue: 'enabled',
      // missing headerKey!
    });
  }, /Both 'headerKey' and 'headerValue' must be provided together/);
});

test('CanarySchema - enforces weight bounds between 0 and 100', () => {
  assert.throws(() => {
    canarySchema.parse({
      enabled: true,
      canaryUpstream: 'service-v2',
      weight: 150, // invalid: > 100
    });
  });

  assert.throws(() => {
    canarySchema.parse({
      enabled: true,
      canaryUpstream: 'service-v2',
      weight: -5, // invalid: < 0
    });
  });
});
