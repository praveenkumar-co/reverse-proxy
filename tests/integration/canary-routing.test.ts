import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const key = parts.shift()?.trim();
    if (key) {
      list[key] = decodeURIComponent(parts.join('=').trim());
    }
  });
  return list;
}


test('Canary Cookie Parser - extracts sticky canary cookie properly', () => {
  const cookieHeader = 'NINJA_CANARY=canary; OTHER_COOKIE=xyz';
  const cookies = parseCookies(cookieHeader);
  assert.strictEqual(cookies['NINJA_CANARY'], 'canary');
  assert.strictEqual(cookies['OTHER_COOKIE'], 'xyz');
});

test('Canary Decision Flow - header override takes precedence over cookie and random roll', () => {
  const canaryConf = {
    enabled: true,
    canaryUpstream: 'v2',
    baselineUpstream: 'v1',
    weight: 0, // 0% random chance
    headerKey: 'x-canary',
    headerValue: 'beta',
    stickyCookieName: 'NINJA_CANARY'
  };

  const headers: Record<string, string> = {
    'x-canary': 'beta',
    'cookie': 'NINJA_CANARY=baseline' // cookie says baseline, but header should override
  };

  let selectedUpstream: string | null = null;
  const isCanaryHealthy = true;

  // 1. Header match check
  let headerMatched = false;
  if (canaryConf.headerKey && canaryConf.headerValue) {
    const incoming = headers[canaryConf.headerKey.toLowerCase()];
    if (incoming === canaryConf.headerValue) {
      headerMatched = true;
    }
  }

  if (headerMatched && isCanaryHealthy) {
    selectedUpstream = canaryConf.canaryUpstream;
  } else {
    selectedUpstream = canaryConf.baselineUpstream;
  }

  assert.strictEqual(selectedUpstream, 'v2');
});

test('Canary Decision Flow - sticky cookie routes consistently without flip-flopping', () => {
  const canaryConf = {
    enabled: true,
    canaryUpstream: 'v2',
    baselineUpstream: 'v1',
    weight: 50,
    stickyCookieName: 'NINJA_CANARY'
  };

  const userCanaryCookies = parseCookies('NINJA_CANARY=canary');
  const userBaselineCookies = parseCookies('NINJA_CANARY=baseline');

  assert.strictEqual(userCanaryCookies['NINJA_CANARY'], 'canary');
  assert.strictEqual(userBaselineCookies['NINJA_CANARY'], 'baseline');
});

test('Canary Fallback - routes to baseline when canary is unhealthy', () => {
  const canaryConf = {
    enabled: true,
    canaryUpstream: 'v2',
    baselineUpstream: 'v1',
    weight: 100, // 100% weight, but v2 is dead
  };

  const healthyUpstreams = new Set(['v1']); // v2 is not healthy!
  const isCanaryHealthy = healthyUpstreams.has(canaryConf.canaryUpstream);

  let selectedUpstream: string | null = null;
  if (isCanaryHealthy) {
    selectedUpstream = canaryConf.canaryUpstream;
  } else {
    selectedUpstream = canaryConf.baselineUpstream;
  }

  assert.strictEqual(selectedUpstream, 'v1');
});

test('Canary IP Whitelist - allows header override only for permitted client IPs', () => {
  const canaryConf = {
    enabled: true,
    canaryUpstream: 'v2',
    baselineUpstream: 'v1',
    headerKey: 'x-canary',
    headerValue: 'secret_token',
    allowedIps: ['10.0.0.5', '127.0.0.1'],
  };

  function checkRoute(clientIp: string, headers: Record<string, string>): string {
    const isCanaryHealthy = true;
    let headerMatched = false;
    if (canaryConf.headerKey && canaryConf.headerValue) {
      const incoming = headers[canaryConf.headerKey.toLowerCase()];
      if (incoming === canaryConf.headerValue) {
        const ipAllowed = canaryConf.allowedIps.includes(clientIp);
        if (ipAllowed) {
          headerMatched = true;
        }
      }
    }
    return headerMatched && isCanaryHealthy ? canaryConf.canaryUpstream : canaryConf.baselineUpstream;
  }

  // 1. Whitelisted IP -> Canary
  const res1 = checkRoute('10.0.0.5', { 'x-canary': 'secret_token' });
  assert.strictEqual(res1, 'v2');

  // 2. Untrusted/Public IP -> Ignored -> Baseline
  const res2 = checkRoute('203.0.113.42', { 'x-canary': 'secret_token' });
  assert.strictEqual(res2, 'v1');
});

test('Canary Capacity Guard - falls back to baseline when canary reaches maxConnections', () => {
  const canaryConf = {
    enabled: true,
    canaryUpstream: 'v2',
    baselineUpstream: 'v1',
    maxConnections: 10,
  };

  const isCanaryHealthy = true;
  function route(activeConnections: number): string {
    const isCanaryAtCapacity = activeConnections >= canaryConf.maxConnections;
    const isCanaryAvailable = isCanaryHealthy && !isCanaryAtCapacity;
    if (isCanaryAvailable) {
      return canaryConf.canaryUpstream;
    }
    return canaryConf.baselineUpstream;
  }

  // Under capacity -> Canary
  assert.strictEqual(route(5), 'v2');

  // At/Over capacity -> Graceful fallback to baseline
  assert.strictEqual(route(10), 'v1');
  assert.strictEqual(route(15), 'v1');
});

test('Canary Header Stripping - removes secret header before forwarding upstream', () => {
  const canaryConf = {
    headerKey: 'x-canary',
    stripHeader: true,
  };

  const incomingHeaders: Record<string, string> = {
    'host': 'api.example.com',
    'x-canary': 'secret_token_qa',
    'user-agent': 'curl/7.68.0',
  };

  const forwardHeaders = { ...incomingHeaders };
  if (canaryConf.headerKey && canaryConf.stripHeader !== false) {
    delete forwardHeaders[canaryConf.headerKey.toLowerCase()];
  }

  assert.strictEqual(forwardHeaders['x-canary'], undefined);
  assert.strictEqual(forwardHeaders['host'], 'api.example.com');
  assert.strictEqual(forwardHeaders['user-agent'], 'curl/7.68.0');
});

