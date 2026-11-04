# 📊 Test Execution Results & Reports

This directory stores historical test run outputs, benchmark logs, latency profiles, and telemetry validation snapshots organized by testing tier.

```
result/
├── unit-tests/              # Level 1: 183 in-memory unit & algorithm audit results
├── smoke-tests/             # Level 2: Transport & protocol smoke check results
├── integration-tests/       # Level 3: Strict 10-point real-application E2E reports
├── chaos-tests/             # Level 4: Upstream kill, network flap & failover logs
├── load-tests/              # Level 5: k6 / Autocannon sustained RPS & latency percentiles
├── python-fastapi-conduit/  # Polyglot Audit: Python FastAPI RealWorld full gateway verification
├── java-spring-boot-qkd/    # Polyglot Audit: Java 21 Spring Boot QKD Simulation gateway verification
├── kotlin-ktor-realworld/   # Polyglot Audit: Kotlin 2.1 Ktor Netty RealWorld gateway verification
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
| [load-tests/](./load-tests/README.md) | Hyperscale multi-method load (P2C algorithm, 1,000 VUs, 17.7k RPS peak) | **10/10 Passed (627k Reqs, 1,000 VUs)** |
| [python-fastapi-conduit/](./python-fastapi-conduit/README.md) | Python FastAPI RealWorld: E2E, 1.9k RPS load, rate limiting, circuit breaker | **100% Passed (10/10 E2E, 0% Error Rate)** |
| [java-spring-boot-qkd/](./java-spring-boot-qkd/README.md) | Java 21 Spring Boot QKD: BB84 Quantum Key Distribution, 19k RPS burst, AES-256 | **100% Passed (10/10 E2E, Upstream UP)** |
| [kotlin-ktor-realworld/](./kotlin-ktor-realworld/README.md) | Kotlin 2.1 Ktor RealWorld: Coroutines, Netty, JWT, 15.5k RPS burst | **100% Passed (10/10 E2E, Upstream UP)** |

---

## Logging Guidelines for Test Runs
When recording future test runs:
1. Include timestamp (ISO 8601).
2. Record commit SHA and proxy version.
3. Record hardware / environment specs (e.g. Apple Silicon M-series, Linux x86_64).
4. Save raw terminal summary alongside any graphical outputs.
