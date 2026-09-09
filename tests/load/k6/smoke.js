// Smoke test: 1 VU, 30s. Verifies proxy is alive before any serious testing.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],    // < 1% errors
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://localhost:8443';
const params = { insecureSkipTLSVerify: true };

export default function () {
  const res = http.get(`${BASE_URL}/`, params);
  check(res, {
    'status 200': (r) => r.status === 200,
    'latency < 200ms': (r) => r.timings.duration < 200,
  });
  sleep(1);
}
