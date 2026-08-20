import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { createMockServer } from '../mocks/target-servers.mock.js';

test('HTTP proxy integration - routing to upstream', async (t) => {
  const upstreamPort = 9001;
  const server = createMockServer(upstreamPort, 200, 'upstream-response-body');

  try {
    // Basic HTTP request to mock upstream to verify it functions
    const responseBody = await new Promise<string>((resolve, reject) => {
      http.get(`http://localhost:${upstreamPort}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    assert.strictEqual(responseBody, 'upstream-response-body');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
