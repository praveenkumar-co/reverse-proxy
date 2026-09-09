import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const CONFIG_FILE = path.join(__dirname, 'config.load.yaml');
const K6_SCRIPT = path.join(__dirname, 'k6', 'live-benchmark.js');

const MOCK_PORTS = [9001, 9002, 9003, 9004];
const PROXY_PORT = 9080;

function createMockUpstream(port, id) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Backend-Server': id,
      });
      res.end(JSON.stringify({ status: 'ok', server: id, path: req.url, bodyLength: body.length }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function waitForProxyReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${PROXY_PORT}/__lb-stats`, (res) => resolve(res.statusCode === 200));
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  console.log('------------------------------------------------------------');
  console.log('🎯 STARTING OFFICIAL GRAFANA K6 LIVE BENCHMARK');
  console.log('------------------------------------------------------------');

  // 1. Start real backend mock nodes
  const servers = [];
  const ids = ['app-a', 'app-b', 'app-c', 'app-d'];
  for (let i = 0; i < MOCK_PORTS.length; i++) {
    servers.push(await createMockUpstream(MOCK_PORTS[i], ids[i]));
  }
  console.log('[Setup] 4 Upstream microservice nodes online on ports 9001-9004.');

  // 2. Start reverse proxy
  console.log('[Setup] Launching Ninja Reverse Proxy cluster...');
  const proxyProcess = spawn('node', [path.join(ROOT_DIR, 'dist', 'index.js'), '--config', CONFIG_FILE], {
    cwd: ROOT_DIR,
    stdio: 'ignore',
  });

  const ready = await waitForProxyReady(20000);
  if (!ready) {
    console.error('❌ Proxy failed to start!');
    proxyProcess.kill('SIGTERM');
    for (const s of servers) await new Promise((r) => s.close(r));
    process.exit(1);
  }
  console.log('[Setup] Proxy cluster ready and accepting traffic on port 9080.');
  console.log('[Execute] Executing /opt/homebrew/bin/k6 binary...\n');

  // 3. Run official k6 binary
  const k6Process = spawn('/opt/homebrew/bin/k6', [
    'run',
    '--env', `BASE_URL=http://127.0.0.1:${PROXY_PORT}`,
    K6_SCRIPT,
  ], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  const cleanup = async () => {
    console.log('\n[Cleanup] Stopping reverse proxy and upstream nodes...');
    proxyProcess.kill('SIGTERM');
    for (const s of servers) await new Promise((r) => s.close(r));
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(143);
  });

  k6Process.on('close', async (code) => {
    await cleanup();
    console.log('[Cleanup] Done. k6 benchmark exited with code:', code);
    process.exit(code ?? 0);
  });
}

run().catch(console.error);
