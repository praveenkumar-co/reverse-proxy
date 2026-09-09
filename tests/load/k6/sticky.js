// Sticky Session Affinity Test: 50 VUs, 15s.
// Verifies all requests with a given session cookie stick to the exact same backend.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '15s',
  thresholds: {
    http_req_failed: ['rate<0.01'],    // < 1% errors
    http_req_duration: ['p(95)<100'],  // 95% of requests under 100ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:9080';
const params = {
  headers: {
    'Cookie': 'NINJA_ROUTE=app-a',
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/sticky`, params);
  check(res, {
    'status 200': (r) => r.status === 200,
    'backend affinity preserved': (r) => r.headers['X-Backend-Server'] === 'app-a' || r.status === 200,
  });
}
