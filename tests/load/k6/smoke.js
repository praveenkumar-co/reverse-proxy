import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  insecureSkipTLSVerify: true,
};

const baseUrl = __ENV.BASE_URL || 'https://localhost:8443';

export default function () {
  const res = http.get(`${baseUrl}/health`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
