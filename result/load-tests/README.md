# Load Test Results

## What Is Tested Here
Throughput and latency under sustained and burst traffic.
Goal: establish baseline RPS, P99 latency, and error rate at different concurrency levels.

## Planned Test Scenarios
| Scenario | Tool | VUs | Duration | Target |
|----------|------|-----|----------|--------|
| Smoke | k6 / autocannon | 1 | 30s | Baseline |
| Ramp | k6 | 1→50 | 5m | No errors |
| Stress | k6 | 200 | 10m | < 1% error rate |
| Spike | k6 | 0→500→0 | 3m | Circuit breaker observed |
| Soak | k6 | 50 | 30m | Stable memory, no leak |

## Test Scripts
```
tests/load/k6/smoke.js
tests/load/k6/stress.js
tests/load/k6/spike.js
```

## How to Run (once k6 is installed)
```bash
k6 run --env BASE_URL=https://localhost:8443 tests/load/k6/smoke.js
k6 run --env BASE_URL=https://localhost:8443 tests/load/k6/stress.js
```

## Results
_Load test results will be added here after load testing stage. Each run should record: date, scenario, RPS, P50/P95/P99 latency, error rate, memory usage._
