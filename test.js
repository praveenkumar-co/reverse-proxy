import http from "k6/http";
import { sleep, check } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const errorRate = new Rate("error_rate");
const responseTime = new Trend("response_time");
const successCount = new Counter("success_count");
const failCount = new Counter("fail_count");

const BASE_URL = "https://localhost:8443";

export const options = {
  insecureSkipTLSVerify: true,
stages: [
  { duration: '45s', target: 50  },  
  { duration: '45s', target: 100 }, 
  { duration: '45s', target: 150 }, 
  { duration: '45s', target: 175 },  
  { duration: '45s', target: 200 },  
  { duration: '45s', target: 100 },  
  { duration: '30s', target: 0   },
  // gradually reducing the load to again test 
],
  thresholds: {
  error_rate: ['rate<0.2'],
  http_req_duration: ['p(95)<1500'],
}
};

export default function () {
  // ── Har VU ka alag fake IP ──
  const fakeIP = `${Math.floor(Math.random() * 255)}.${Math.floor(
    Math.random() * 255
  )}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  const params = {
    headers: {
      "X-Forwarded-For": fakeIP,
    },
    timeout: "30s",
    insecureSkipTLSVerify: true,
  };

  const rand = Math.random();

  if (rand < 0.7) {
    const res = http.get(`${BASE_URL}/`, params);
    const ok = check(res, {
      "GET status 200": (r) => r.status === 200,
      "GET latency < 250ms": (r) => r.timings.duration < 250,
    });
    track(res, ok);
  } else {
    const payload = JSON.stringify({
      test: "payload",
      ts: Date.now(),
      userId: Math.floor(Math.random() * 10000),
    });
    const res = http.post(`${BASE_URL}/`, payload, {
      ...params,
      headers: {
        ...params.headers,
        "Content-Type": "application/json",
      },
    });
    const ok = check(res, {
      "POST status ok": (r) => r.status === 200 || r.status === 201,
      "POST latency < 400ms": (r) => r.timings.duration < 400,
    });
    track(res, ok);
  }

  sleep(Math.random() * 0.3);
}

function track(res, ok) {
  responseTime.add(res.timings.duration);
  errorRate.add(!ok);
  if (ok) successCount.add(1);
  else failCount.add(1);
}

