# 📊 Test Execution Results & Reports

This directory stores historical test run outputs, benchmark logs, latency profiles, and telemetry validation snapshots organized by testing tier.

```
result/
├── unit-tests/              # Level 1: 183 in-memory unit & algorithm audit results
├── smoke-tests/             # Level 2: Transport & protocol smoke check results
├── integration-tests/       # Level 3: Strict 10-point real-application E2E reports
├── chaos-tests/             # Level 4: Upstream kill, network flap & failover logs
├── load-tests/              # Level 5: k6 / Autocannon sustained RPS & latency percentiles
└── request_check_for_graf.t/# Historical Grafana metric validation logs & screenshot
```

---

## Directory Index

| Subdirectory | Verification Scope | Status |
|---|---|---|
| [unit-tests/](./unit-tests/README.md) | In-memory algorithm validation (12 LB strategies, 5 rate limiters, LRU, SWR) | **183/183 Passed** |
| [smoke-tests/](./smoke-tests/README.md) | Protocol validation (HTTP 8080 redirect, TLS handshake, WebSocket 101) | **6/6 Passed** |
| [integration-tests/](./integration-tests/README.md) | End-to-end integration against real live backends (Chess app on 3009/3010) | **10/10 Passed** |
| [chaos-tests/](./chaos-tests/README.md) | Node failure injection, circuit breaker tripping, zero 502 failover | Ready for Chaos runs |
| [load-tests/](./load-tests/README.md) | Throughput ceiling (RPS), P50/P95/P99 latency curves, memory leak soak | Ready for Stage 3 |

---

## Logging Guidelines for Test Runs
When recording future test runs:
1. Include timestamp (ISO 8601).
2. Record commit SHA and proxy version.
3. Record hardware / environment specs (e.g. Apple Silicon M-series, Linux x86_64).
4. Save raw terminal summary alongside any graphical outputs.
