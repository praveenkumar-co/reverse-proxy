// Sliding Window Counter Rate Limiting Test: 80 VUs, 10s.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 80,
  duration: '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:9080';

export default function () {
  const res = http.get(`${BASE_URL}/api/sliding`);
  check(res, {
    'valid status 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}
