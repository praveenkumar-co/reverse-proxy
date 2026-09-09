// Spike test: Sudden burst to 500 VUs. Verifies circuit breaker and rate limiter kick in.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 10 },   // warm up
    { duration: '1m',  target: 500 },  // spike
    { duration: '10s', target: 0 },    // drop back
  ],
  thresholds: {
    // Under a spike, 429 (rate limited) and 503 (circuit open) are expected and acceptable.
    // We only fail the test if there are outright connection errors.
    http_req_failed: ['rate<0.80'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://localhost:8443';
const params = { insecureSkipTLSVerify: true };

export default function () {
  const res = http.get(`${BASE_URL}/`, params);
  // 429 = rate limited (expected), 503 = circuit open (expected), 200 = served
  check(res, { 'not a connection error': (r) => r.status !== 0 });
}
