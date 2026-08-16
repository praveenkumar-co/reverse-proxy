import http from 'k6/http';
import { check } from 'k6';

export const options = { vus: 1, duration: '30s' };

export default function () {
  const res = http.get('https://localhost:8443/health');
  check(res, { 'status is 200': (r) => r.status === 200 });
}
