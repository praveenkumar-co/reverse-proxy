import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { createMockServer } from '../mocks/target-servers.mock.js';

test('HTTP proxy integration - routing to upstream', async () => {
  const { server, port } = await createMockServer(0, 200, 'upstream-response-body');
  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}`, (res) => {
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
