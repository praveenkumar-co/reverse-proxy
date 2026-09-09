# Integration Test Results

## What Is Tested Here
Tests that connect through the live proxy stack (ports 8080/8443) to real backend services.
Verifies the entire request path: TLS → Master → Worker → Upstream → Response.

## Test Files
| File | What It Verifies |
|------|------------------|
| tests/universal-app-test.mjs | 10-point strict real-app verification (T01–T10) |
| tests/live-integration-test.mjs | 6-point protocol smoke (redirect, TLS, WS, metrics) |
| tests/integration/failover.test.ts | Circuit breaker failover, upstream exclusion |
| tests/integration/websocket.test.ts | WebSocket upgrade tunneling |
| tests/integration/http-proxy.test.ts | HTTP proxy routing to upstream |
| tests/integration/hot-reload.test.ts | Config hot-reload via SIGHUP |

## Prerequisites
- Proxy running on ports 8080 (HTTP) and 8443 (HTTPS)
- Chess backend running on ports 3009 and 3010

## How to Run
```bash
npm run test:live        # Protocol smoke (6 checks)
npm run test:universal   # Strict real-app integration (10 checks)
```

## Results
_Results are recorded here after each run._
