# Chaos Test Results

## What Is Tested Here
Failure injection to verify resilience subsystems under real failure conditions.

## Planned Scenarios
| Scenario | What Fails | Expected Proxy Behavior |
|----------|-----------|-------------------------|
| Upstream kill | Kill chess-backend-1 (port 3009) | Proxy detects DOWN via passive probe, circuit breaker opens, all traffic rerouted to chess-backend-2 |
| Slow upstream | Introduce 3s delay on backend | Retry timeout fires, bulkhead slot freed, 503 returned cleanly |
| Memory pressure | Stress host RAM | LRU evicts entries, proxy continues serving |
| Rapid flap | Toggle upstream UP/DOWN every 5s | Health state machine transitions correctly, no thundering herd |

## Test Files
```
tests/chaos/upstream-failure.chaos.ts
```

## Results
_Chaos test results will be added here. Include: scenario, observed proxy behavior, recovery time._
