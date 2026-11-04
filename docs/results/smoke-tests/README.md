# Smoke Test Results

## What Is Tested Here
Fast sanity checks run before every integration or load test session.
Verifies: TLS handshake, port availability, metrics endpoint, redirect chain.

## Checks
| Check | Command | Expected |
|-------|---------|----------|
| HTTP redirect | `curl -I http://localhost:8080/` | `301 Location: https://` |
| HTTPS response | `curl -k https://localhost:8443/` | `200 OK` |
| Metrics scrape | `curl -k https://localhost:8443/metrics` | Contains `ninja_http_requests_total` |
| WebSocket port | `nc -z localhost 8443` | Open |
| Backend 3009 | `curl http://localhost:3009/` | `200 OK` |
| Backend 3010 | `curl http://localhost:3010/` | `200 OK` |

## How to Run
```bash
npm run test:live
```

## Results
_Results are recorded here after each run._
