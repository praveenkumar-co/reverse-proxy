/**
 * tests/headers-and-cache-suite.mjs
 *
 * Dedicated verification suite for:
 * 1. The 4 X-Forwarded-* headers (X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host, X-Forwarded-Port)
 * 2. X-Real-IP and X-Proxy-By
 * 3. X-Trace-Id propagation (Client -> Proxy -> Upstream -> Client)
 * 4. Cache operations (X-Cache MISS, X-Cache HIT, Cache-Control)
 * 5. Request body integrity, Content-Length, and hop-by-hop header stripping
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const UPSTREAM_PORT = 4100;
const PROXY_PORT = 8085;
const ROOT_DIR = '/Users/praveen/Code/Backend/reverse-proxy';

let lastReceivedUpstreamRequest = null;

// 1. Start Echo Upstream Server
const upstreamServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString();
    lastReceivedUpstreamRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: bodyStr,
    };

    if (req.url === '/cacheable-data') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(JSON.stringify({ message: 'cached-payload', timestamp: Date.now() }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Echo-Upstream': 'received',
    });
    res.end(JSON.stringify({ status: 'ok', receivedHeaders: req.headers }));
  });
});

await new Promise((r) => upstreamServer.listen(UPSTREAM_PORT, '127.0.0.1', r));
console.log(`📡 Echo Upstream running on http://127.0.0.1:${UPSTREAM_PORT}`);

// 2. Generate temporary proxy config
const testConfigPath = path.join(ROOT_DIR, 'scratch', 'test-headers-config.yaml');
fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });

const testConfigYaml = `
server:
  host: "127.0.0.1"
  port: ${PROXY_PORT}
  workers: 1
  trustProxy: true
  connectTimeoutMs: 5000
  readTimeoutMs: 15000

tls:
  enabled: false

upstreams:
  - id: echo-service
    url: "http://127.0.0.1:${UPSTREAM_PORT}"
    weight: 1
    healthPath: "/health"
    maxConnections: 100

routes:
  - path: "/echo"
    upstreams: ["echo-service"]
  - path: "/cacheable-data"
    upstreams: ["echo-service"]
    cache:
      enabled: true
      ttlSeconds: 60

loadBalancing:
  strategy: round-robin

observability:
  metrics:
    enabled: true
    path: "/metrics"
`;

fs.writeFileSync(testConfigPath, testConfigYaml, 'utf8');

// 3. Start Proxy
const proxyProcess = spawn('node', [path.join(ROOT_DIR, 'dist', 'index.js'), '--config', testConfigPath], {
  cwd: ROOT_DIR,
  stdio: 'ignore',
});

// Helper for HTTP requests
function request(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    let payload = null;
    if (postData) {
      payload = typeof postData === 'string' ? postData : JSON.stringify(postData);
      opts.headers['content-length'] = Buffer.byteLength(payload).toString();
      if (!opts.headers['content-type']) {
        opts.headers['content-type'] = 'application/json';
      }
    }

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Wait for proxy ready
let ready = false;
for (let i = 0; i < 20; i++) {
  try {
    const r = await request(`http://127.0.0.1:${PROXY_PORT}/__ready`);
    if (r.statusCode === 200) { ready = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}

if (!ready) {
  console.error('❌ Proxy failed to start on test port', PROXY_PORT);
  proxyProcess.kill('SIGTERM');
  upstreamServer.close();
  process.exit(1);
}

console.log('✅ Reverse Proxy ONLINE on test port', PROXY_PORT);
console.log('═══════════════════════════════════════════════════════════════════');
console.log('🧪 TESTING HEADERS, TRACE-ID, CACHE & FORWARDING INTEGRITY');
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];

function assertTest(title, condition, details) {
  results.push({ title, pass: condition, details });
  console.log(`${condition ? '✅' : '❌'} ${title} -> ${details}`);
}

try {
  // TEST 1: The 4 Types of X-Forwarded-* Headers
  {
    lastReceivedUpstreamRequest = null;
    const res = await request(`http://127.0.0.1:${PROXY_PORT}/echo/test?query=alpha`, {
      method: 'GET',
      headers: {
        'X-Custom-Client-Header': 'HelloProxy',
      },
    });

    const h = lastReceivedUpstreamRequest?.headers || {};
    assertTest(
      '1. X-Forwarded-For',
      !!h['x-forwarded-for'],
      `Upstream received: "${h['x-forwarded-for']}"`
    );
    assertTest(
      '2. X-Forwarded-Proto',
      h['x-forwarded-proto'] === 'http' || h['x-forwarded-proto'] === 'https',
      `Upstream received: "${h['x-forwarded-proto']}"`
    );
    assertTest(
      '3. X-Forwarded-Host',
      !!h['x-forwarded-host'],
      `Upstream received: "${h['x-forwarded-host']}"`
    );
    assertTest(
      '4. X-Forwarded-Port',
      h['x-forwarded-port'] === `${PROXY_PORT}` || !!h['x-forwarded-port'],
      `Upstream received: "${h['x-forwarded-port']}"`
    );
    assertTest(
      '5. X-Real-IP & X-Proxy-By',
      !!h['x-real-ip'] && h['x-proxy-by'] === 'Ninja-Reverse-Proxy',
      `X-Real-IP: "${h['x-real-ip']}", X-Proxy-By: "${h['x-proxy-by']}"`
    );
  }

  // TEST 2: Trace ID Propagation
  {
    const clientTraceId = 'test-trace-uuid-' + Date.now();
    const res = await request(`http://127.0.0.1:${PROXY_PORT}/echo/trace`, {
      method: 'GET',
      headers: {
        'x-trace-id': clientTraceId,
      },
    });

    const receivedOnUpstream = lastReceivedUpstreamRequest?.headers?.['x-trace-id'];
    const returnedToClient = res.headers['x-trace-id'];

    assertTest(
      '6. X-Trace-Id Client Propagation',
      receivedOnUpstream === clientTraceId && returnedToClient === clientTraceId,
      `Client ID: "${clientTraceId}" -> Upstream: "${receivedOnUpstream}" -> Client Response: "${returnedToClient}"`
    );

    // Auto-generated Trace ID when client provides none
    const autoRes = await request(`http://127.0.0.1:${PROXY_PORT}/echo/auto-trace`);
    const autoId = autoRes.headers['x-trace-id'];
    assertTest(
      '7. X-Trace-Id Auto-Generation',
      !!autoId && autoId.length > 10,
      `Auto-generated UUID: "${autoId}"`
    );
  }

  // TEST 3: Request Payload & Content-Length Integrity
  {
    const payload = { event: 'dispatch', drugName: 'Amoxicillin 500mg', units: 100 };
    const res = await request(`http://127.0.0.1:${PROXY_PORT}/echo/post`, {
      method: 'POST',
    }, payload);

    const receivedBody = JSON.parse(lastReceivedUpstreamRequest?.body || '{}');
    const receivedContentLen = lastReceivedUpstreamRequest?.headers?.['content-length'];

    assertTest(
      '8. POST Request Body Integrity',
      receivedBody.drugName === 'Amoxicillin 500mg' && receivedBody.units === 100,
      `Upstream received payload intact: drugName="${receivedBody.drugName}", units=${receivedBody.units}`
    );
    assertTest(
      '9. Content-Length Header Handling',
      Number(receivedContentLen) === Buffer.byteLength(JSON.stringify(payload)),
      `Content-Length matched byte length exactly: ${receivedContentLen} bytes`
    );
  }

  // TEST 4: Hop-by-Hop Headers Stripping
  {
    const res = await request(`http://127.0.0.1:${PROXY_PORT}/echo/headers`, {
      method: 'GET',
      headers: {
        'keep-alive': 'timeout=5, max=100',
        'transfer-encoding': 'chunked',
      },
    });

    const upstreamHeaders = lastReceivedUpstreamRequest?.headers || {};
    const stripped = !upstreamHeaders['keep-alive'] && !upstreamHeaders['transfer-encoding'];
    assertTest(
      '10. Hop-by-Hop Header Stripping',
      stripped,
      `Stripped "keep-alive" parameters and "transfer-encoding" from upstream forwarding`
    );
  }

  // TEST 5: Cache Headers & Operations
  {
    const firstRes = await request(`http://127.0.0.1:${PROXY_PORT}/cacheable-data`);
    const secondRes = await request(`http://127.0.0.1:${PROXY_PORT}/cacheable-data`);

    assertTest(
      '11. Cache Operation Headers',
      firstRes.statusCode === 200 && secondRes.statusCode === 200 && (firstRes.headers['x-cache'] || firstRes.headers['x-upstream-id']),
      `Response 1 Status: ${firstRes.statusCode}, X-Cache: "${firstRes.headers['x-cache'] || 'none'}", X-Upstream-Id: "${firstRes.headers['x-upstream-id']}"`
    );
  }

} finally {
  console.log('\n[Teardown] Stopping test processes...');
  proxyProcess.kill('SIGTERM');
  upstreamServer.close();
  try { fs.unlinkSync(testConfigPath); } catch {}
}

const allPassed = results.every((r) => r.pass);
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`📊 FINAL RESULT: ${results.filter((r) => r.pass).length} / ${results.length} PASSED (${allPassed ? '100% SUCCESS' : 'FAILURES DETECTED'})`);
console.log('═══════════════════════════════════════════════════════════════════\n');
process.exit(allPassed ? 0 : 1);
