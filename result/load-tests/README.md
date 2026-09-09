# Load Test Results

## What Is Tested Here
Throughput and latency under sustained and burst traffic.
Goal: establish baseline RPS, P99 latency, and error rate at different concurrency levels.

## Planned Test Scenarios
| Scenario | Tool | VUs | Duration | Target |
|----------|------|-----|----------|--------|
| Smoke | k6 / load-runner | 1 | 10s | Baseline |
| Ramp | k6 / load-runner | 20 | 15s | No errors |
| Stress | k6 / load-runner | 50 | 15s | < 1% error rate |
| Cache | k6 / load-runner | 40 | 10s | L1 memory hit acceleration |
| Spike | k6 / load-runner | 60 | 8s | Token-bucket 429 rate limit observed |

## Test Scripts
```
tests/load/load-runner.mjs     # Automated end-to-end benchmark suite
tests/load/k6/smoke.js        # k6 smoke script
tests/load/k6/stress.js       # k6 stress script
tests/load/k6/spike.js        # k6 spike script
tests/load/k6/cache.js        # k6 cache speedup script
```

## How to Run
```bash
# Automated runner (starts mocks, proxy & benchmarks):
node tests/load/load-runner.mjs

# Or with k6 directly:
k6 run --env BASE_URL=http://localhost:9080 tests/load/k6/smoke.js
```

## Results

### Latest Benchmark Execution (Sep 9, 2026)

| Scenario | VUs | Duration | Throughput | P50 Latency | P95 Latency | P99 Latency | Error Rate | Memory | Status |
|---|---|---|---|---|---|---|---|---|---|
| Smoke (Baseline Overhead) | 1 | 10s | **1626.8 req/s** | `0.53ms` | `0.94ms` | `1.63ms` | 0.00% | 50.8 MB | ✅ PASS |
| Ramp (Normal Production Concurrency) | 20 | 15s | **6071.4 req/s** | `2.82ms` | `5.99ms` | `10.48ms` | 0.00% | 80.5 MB | ✅ PASS |
| Stress (Throughput Ceiling) | 50 | 15s | **7163.7 req/s** | `6.31ms` | `11.51ms` | `20.81ms` | 0.00% | 83.8 MB | ✅ PASS |
| Cache Acceleration (L1 Memory Hit) | 40 | 10s | **6642.7 req/s** | `5.20ms` | `10.22ms` | `18.91ms` | 0.00% | 79.0 MB | ✅ PASS |
| Spike (Rate Limiter 429 Defense) | 60 | 8s | **28513.9 req/s** | `1.59ms` | `4.26ms` | `7.81ms` | 0.00% | 88.7 MB | ✅ PASS |

👉 **[View Full In-Depth Benchmark Report](./load-test-report.md)**  
👉 **[View Raw JSON Data](./load_test_results.json)**
