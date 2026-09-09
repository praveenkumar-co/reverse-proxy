// Rate Limiting Protection Test: 120 VUs, 10s.
// Tests token-bucket algorithm under heavy concurrency.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 120,
  duration: '10s',
  thresholds: {
    // Under heavy traffic, 200 and 429 are valid responses.
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:9080';

export default function () {
  const res = http.get(`${BASE_URL}/api/limited`);
  check(res, {
    'valid status 200 or 429': (r) => r.status === 200 || r.status === 429,
    'retry-after header present on 429': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });
}
