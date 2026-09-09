# Tests

This directory contains all test suites organized by level.

## Structure
```
tests/
├── unit/                    # In-memory module tests (no running server)
│   ├── balancer/            # Load balancing strategy tests
│   ├── cache/               # LRU, HybridCache, invalidation tests
│   ├── discovery/           # ServiceRegistry, ActiveProbe, PassiveProbe
│   ├── observability/       # Histogram, MetricsRegistry, TenantLogStreamer
│   ├── ratelimit/           # All 5 algorithms + SoftLimitPolicy + stores
│   └── resilience/          # ClassicCB, AdaptiveCB, Bulkhead, RetryBudget, Backoffs
│
├── integration/             # Tests that need the real proxy + backend running
│   ├── failover.test.ts     # Circuit breaker failover via LB
│   ├── hot-reload.test.ts   # Config reload via SIGHUP
│   ├── http-proxy.test.ts   # HTTP routing to upstream
│   └── websocket.test.ts    # WebSocket upgrade tunneling
│
├── load/                    # Load & stress test scripts
│   └── k6/                  # k6 test scripts
│       ├── smoke.js         # 1 VU, 30s — baseline sanity
│       ├── stress.js        # Ramp to 200 VUs — sustained load
│       └── spike.js         # Sudden spike to 500 VUs — burst resilience
│
├── chaos/                   # Failure injection tests
│   └── upstream-failure.chaos.ts  # Upstream kill + recovery verification
│
├── mocks/                   # Reusable test server factories
│   └── target-servers.mock.ts     # createMockServer(port, status, body)
│
├── full-system-audit.mjs    # 183-test in-memory full system audit (fastest)
├── live-integration-test.mjs # 6-point live protocol smoke test
└── universal-app-test.mjs   # 10-point strict real-app integration test
```

## Running Tests

### Before Running Any Test
Make sure the TypeScript source is compiled:
```bash
npm run build
```

### Unit Tests (no server needed)
```bash
npm run test:audit          # 183-test in-memory audit — runs in ~3s
npm test                    # Official compiled unit + integration suite
```

### Integration Tests (proxy + backend must be running)
```bash
# Start proxy
node dist/index.js

# In another terminal:
npm run test:live           # 6-point protocol smoke
npm run test:universal      # 10-point strict real-app suite
```

### Load Tests (k6 required)
```bash
brew install k6
k6 run --env BASE_URL=https://localhost:8443 tests/load/k6/smoke.js
k6 run --env BASE_URL=https://localhost:8443 tests/load/k6/stress.js
```

## Test Pyramid
```
        /\
       /  \
      / E2E \
     / Load  \
    / Chaos   \
   /Integration\
  /    Unit    \
 /   (183 tests)\
/________________\
```
Bottom (wide): fast, isolated, deterministic.
Top (narrow): slow, real infra, verify full system behavior.
