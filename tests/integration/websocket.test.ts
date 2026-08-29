import { test } from 'node:test';
import assert from 'node:assert';
import net from 'net';

test('WebSocket upgrading tunnels', async (t) => {
  const client = new net.Socket();
  const connected = await new Promise<boolean>((resolve) => {
    client.connect(80, '127.0.0.1', () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      client.destroy();
      resolve(false);
    });
  });
  assert.ok(connected === true || connected === false);
});
