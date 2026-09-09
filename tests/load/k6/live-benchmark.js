// =============================================================================
// OFFICIAL GRAFANA K6 BENCHMARK SUITE FOR NINJA REVERSE PROXY
// =============================================================================
// Executes real multi-method HTTP transactions using the compiled Go k6 engine.
// Measures exact network latency, TTFB, throughput (req/s), and error rates.
// =============================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:9080';

export const options = {
  scenarios: {
    // 1. Sustained Concurrency Test (50 VUs for 10s)
    sustained_concurrency: {
      executor: 'constant-vus',
      vus: 50,
      duration: '10s',
    },
    // 2. High-Throughput Burst (100 VUs for 10s)
    high_throughput_burst: {
      executor: 'constant-vus',
      vus: 100,
      duration: '10s',
      startTime: '12s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],      // Less than 1% errors allowed
    http_req_duration: ['p(95)<100'],   // 95% of requests under 100ms
  },
};

export default function () {
  // 1. GET request with dynamic query parameters
  const getRes = http.get(`${BASE_URL}/api/live?q=search&ts=${Date.now()}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'k6-load-engine/v0.54',
    },
  });

  check(getRes, {
    'GET /api/live status 200': (r) => r.status === 200,
    'GET has backend header': (r) => r.headers['X-Backend-Server'] !== undefined,
  });

  // 2. POST request with real JSON body
  const payload = JSON.stringify({
    client: 'k6-client',
    items: [{ id: 101, qty: 2 }],
    timestamp: Date.now(),
  });

  const postRes = http.post(`${BASE_URL}/api/orders`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  check(postRes, {
    'POST /api/orders status 200': (r) => r.status === 200,
  });
}
