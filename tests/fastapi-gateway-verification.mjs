/**
 * tests/fastapi-gateway-verification.mjs
 *
 * Automated verification suite for Python FastAPI + Ninja Reverse Proxy Gateway.
 */

import http from 'node:http';

const GATEWAY_URL = 'http://127.0.0.1:8080';

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

    const start = Date.now();
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
          durationMs: Date.now() - start,
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('⚡ PYTHON FASTAPI + NINJA REVERSE PROXY GATEWAY VERIFICATION');
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];
function record(step, title, passed, details, latencyMs = 0) {
  results.push({ step, title, passed, details, latencyMs });
  console.log(`${passed ? '✅' : '❌'} [${step}] ${title} (${latencyMs}ms)`);
  console.log(`   └─ ${details}`);
}

async function run() {
  let token = null;
  const uniqueId = Date.now();
  const testUsername = `ninja_author_${uniqueId}`;
  const testEmail = `ninja_author_${uniqueId}@conduit.io`;
  const testPassword = `NinjaSecuredPass2026!`;

  // 1. Gateway Health & Readiness
  {
    const res = await request(`${GATEWAY_URL}/__ready`);
    record(
      '1/10',
      'Gateway Readiness Probe (/__ready)',
      res.statusCode === 200,
      `Status: ${res.statusCode}, Body: ${res.body.trim()}`,
      res.durationMs
    );
  }

  // 2. Interactive Swagger UI through Reverse Proxy
  {
    const res = await request(`${GATEWAY_URL}/docs`);
    const pass = res.statusCode === 200 && res.body.includes('SwaggerUIBundle');
    record(
      '2/10',
      'Interactive Swagger UI (/docs)',
      pass,
      `Status: ${res.statusCode}, Contains SwaggerUI bundle assets`,
      res.durationMs
    );
  }

  // 3. OpenAPI 3.1.0 Specification Schema through Gateway
  {
    const res = await request(`${GATEWAY_URL}/openapi.json`);
    const pass = res.statusCode === 200 && res.json?.openapi && res.json?.paths;
    record(
      '3/10',
      'OpenAPI Spec Discovery (/openapi.json)',
      pass,
      `Status: ${res.statusCode}, OpenAPI version: ${res.json?.openapi}, Endpoints mapped: ${Object.keys(res.json?.paths || {}).length}`,
      res.durationMs
    );
  }

  // 4. User Registration (POST /api/users)
  {
    const payload = {
      user: {
        username: testUsername,
        email: testEmail,
        password: testPassword,
      },
    };
    const res = await request(`${GATEWAY_URL}/api/users`, { method: 'POST' }, payload);
    const pass = (res.statusCode === 200 || res.statusCode === 201) && res.json?.user?.token;
    if (pass) token = res.json.user.token;
    record(
      '4/10',
      'FastAPI User Registration & JWT Minting',
      pass,
      `Status: ${res.statusCode}, Registered: "${testUsername}", JWT Received: ${!!token}`,
      res.durationMs
    );
  }

  // 5. User Authentication & Login (POST /api/users/login)
  {
    const payload = {
      user: {
        email: testEmail,
        password: testPassword,
      },
    };
    const res = await request(`${GATEWAY_URL}/api/users/login`, { method: 'POST' }, payload);
    const pass = res.statusCode === 200 && res.json?.user?.token;
    if (pass) token = res.json.user.token;
    record(
      '5/10',
      'FastAPI User Login & Token Verification',
      pass,
      `Status: ${res.statusCode}, Authenticated user: "${res.json?.user?.username}"`,
      res.durationMs
    );
  }

  // 6. Protected Route with Bearer Token (GET /api/user)
  {
    const res = await request(`${GATEWAY_URL}/api/user`, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${token}`,
      },
    });
    const pass = res.statusCode === 200 && res.json?.user?.email === testEmail;
    record(
      '6/10',
      'Protected Profile Access (JWT Validation)',
      pass,
      `Status: ${res.statusCode}, Profile Email: "${res.json?.user?.email}"`,
      res.durationMs
    );
  }

  // 7. Discover Tags (GET /api/tags)
  {
    const res = await request(`${GATEWAY_URL}/api/tags`);
    const pass = res.statusCode === 200 && Array.isArray(res.json?.tags);
    record(
      '7/10',
      'Query Tags Collection (GET /api/tags)',
      pass,
      `Status: ${res.statusCode}, Tags returned: ${res.json?.tags?.length ?? 0}`,
      res.durationMs
    );
  }

  // 8. Query Articles Feed (GET /api/articles)
  {
    const res = await request(`${GATEWAY_URL}/api/articles`);
    const pass = res.statusCode === 200 && Array.isArray(res.json?.articles);
    record(
      '8/10',
      'Query Articles Feed (GET /api/articles)',
      pass,
      `Status: ${res.statusCode}, Articles found: ${res.json?.articlesCount ?? 0}`,
      res.durationMs
    );
  }

  // 9. Standard Reverse Proxy Headers Integrity
  {
    const res = await request(`${GATEWAY_URL}/docs`);
    const traceId = res.headers['x-trace-id'];
    const upstreamId = res.headers['x-upstream-id'];
    const pass = !!traceId && upstreamId === 'fastapi-service';
    record(
      '9/10',
      'Reverse Proxy Header Telemetry',
      pass,
      `X-Trace-Id: "${traceId}", X-Upstream-Id: "${upstreamId}"`,
      res.durationMs
    );
  }

  // 10. Prometheus Telemetry Exposition (/metrics)
  {
    const res = await request(`${GATEWAY_URL}/metrics`);
    const pass = res.statusCode === 200 &&
      res.body.includes('fastapi-service') &&
      res.body.includes('ninja_http_requests_total');
    record(
      '10/10',
      'Prometheus Metrics Exposition (/metrics)',
      pass,
      `Status: ${res.statusCode}, Prometheus actively scraping fastapi-service with counters`,
      res.durationMs
    );
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  const allPassed = results.every((r) => r.passed);
  console.log(`📊 FINAL RESULT: ${results.filter((r) => r.passed).length} / ${results.length} PASSED (${allPassed ? '100% SUCCESS' : 'FAILURES DETECTED'})`);
  console.log('═══════════════════════════════════════════════════════════════════\n');
}

run().catch(console.error);
