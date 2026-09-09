// Stress test: Ramp from 0 to 200 VUs over 5 minutes, hold, then ramp down.
// Goal: find the throughput ceiling and P99 latency under sustained load.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // ramp up
    { duration: '5m', target: 200 },  // stress
    { duration: '2m', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],      // < 5% error rate allowed
    http_req_duration: ['p(99)<2000'],   // P99 under 2s
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://localhost:8443';
const params = { insecureSkipTLSVerify: true };

export default function () {
  const res = http.get(`${BASE_URL}/`, params);
  check(res, { 'not 5xx': (r) => r.status < 500 });
  sleep(0.5);
}
