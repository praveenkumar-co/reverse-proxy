// =============================================================================
// OFFICIAL GRAFANA K6 HYPERSCALE BENCHMARK (UP TO 1,000 VUs)
// =============================================================================
// Features:
// 1. CPU-Safe Stepped Spikes with Inter-Stage Cooldown Valleys (protects Apple M5)
// 2. Multi-Method Realistic Payloads: GET, POST JSON, PUT
// 3. Header verification (ensures reverse proxy routed to upstream backends)
// =============================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:9080';

export const options = {
  scenarios: {
    cpu_safe_hyperscale: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        // Stage 1: Warmup & Calibration (200 VUs)
        { duration: '3s', target: 200 },
        { duration: '5s', target: 200 },
        // Cooldown Valley 1: Drop to 50 VUs to clear OS socket buffers & cool CPU
        { duration: '2s', target: 50 },

        // Stage 2: Production Scale Stress (500 VUs)
        { duration: '3s', target: 500 },
        { duration: '5s', target: 500 },
        // Cooldown Valley 2
        { duration: '2s', target: 50 },

        // Stage 3: High Concurrency Surge (750 VUs)
        { duration: '3s', target: 750 },
        { duration: '5s', target: 750 },
        // Cooldown Valley 3
        { duration: '2s', target: 50 },

        // Stage 4: Hyperscale Peak Saturation (1,000 VUs)
        { duration: '3s', target: 1000 },
        { duration: '5s', target: 1000 },

        // Graceful ramp down to 0
        { duration: '3s', target: 0 },
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],     // Max 2% failures allowed under 1000 VU peak
    http_req_duration: ['p(95)<350'],  // 95% of requests under 350ms
  },
};

export default function () {
  const vuId = __VU;
  const iterId = __ITER;
  const methodChoice = iterId % 3;

  if (methodChoice === 0) {
    // 1. GET Request with dynamic query params
    const getRes = http.get(`${BASE_URL}/api/catalog?cat=cloud&item=${vuId}&ts=${Date.now()}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': `k6-hyperscale-vu-${vuId}`,
      },
    });

    check(getRes, {
      'GET status 200': (r) => r.status === 200,
      'GET routed to upstream': (r) => r.headers['X-Backend-Server'] !== undefined,
    });
  } else if (methodChoice === 1) {
    // 2. POST Request with realistic JSON payload
    const payload = JSON.stringify({
      orderId: `ord-${vuId}-${iterId}`,
      clientId: `vu-${vuId}`,
      items: [{ sku: 'SKU-PROXY', qty: 1 }],
      timestamp: Date.now(),
    });

    const postRes = http.post(`${BASE_URL}/api/orders`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    check(postRes, {
      'POST status 200': (r) => r.status === 200,
    });
  } else {
    // 3. PUT Request with mutation payload
    const updatePayload = JSON.stringify({
      userId: `user-${vuId}`,
      action: 'heartbeat_sync',
      lastSeen: Date.now(),
    });

    const putRes = http.put(`${BASE_URL}/api/users`, updatePayload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    check(putRes, {
      'PUT status 200': (r) => r.status === 200,
    });
  }
}
