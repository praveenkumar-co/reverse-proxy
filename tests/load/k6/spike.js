import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 500 },
    { duration: '1m', target: 500 },
    { duration: '10s', target: 0 },
  ],
  insecureSkipTLSVerify: true,
};

const baseUrl = __ENV.BASE_URL || 'https://localhost:8443';

export default function () {
  const res = http.get(baseUrl);
  check(res, { 'status ok': (r) => r.status < 500 });
}
