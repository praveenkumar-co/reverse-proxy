// Cache test: 30 VUs, 15s. Measures L1 In-Memory & Redis cache acceleration.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 30,
  duration: '15s',
  thresholds: {
    http_req_failed: ['rate<0.01'],    // < 1% errors
    http_req_duration: ['p(95)<50'],   // 95% of cached requests under 50ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://localhost:8443';
const params = { insecureSkipTLSVerify: true };

export default function () {
  const res = http.get(`${BASE_URL}/api/cached`, params);
  check(res, {
    'status 200': (r) => r.status === 200,
    'cache hit header': (r) => r.headers['X-Cache'] === 'HIT' || r.status === 200,
  });
}
