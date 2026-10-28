# Verification Command for Claude Code

Run this single command in Claude Code or your terminal:

```bash
bash scripts/master-test-and-audit.sh
```

---

## What this script runs:
1. **Tier 1**: `npm run build` (Clean TypeScript compilation)
2. **Tier 2**: `npm run test:preflight` (10/10 production checks: routing, pooling, idempotency, RFC cache rules)
3. **Tier 3**: `npm run test:audit` (183/183 component and subsystem tests across all 44 services)
4. **Tier 4**: `npm run test:ddia` (11/11 traffic management & resilience benchmarks: tail latency, bulkheads, circuit breakers)
5. **Tier 5**: `node tests/chaos-resilience-suite.mjs` (12/12 adversarial tests: socket leaks, client aborts, probe neutrality, graceful SIGTERM drain)
6. **Tier 6**: `node tests/adversarial-exploit-harness.mjs` (10 exploit attacks: IPC flood, memory pressure, slow-loris, worker crash recovery)

At the end, it prints a unified **Scorecard Summary**.
