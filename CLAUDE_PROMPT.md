# Claude Code Directive: Production Exploitation, Resilience Audit & Hardening

Run this command inside Claude Code:

```bash
bash scripts/master-test-and-audit.sh
```

---

## Instructions for Claude Code:

You are auditing and hardening `reverse-proxy`, an enterprise-grade TypeScript/Node.js API gateway.

### Mission:
1. **Execute the Master Suite**:
   Run `bash scripts/master-test-and-audit.sh` to trigger all 6 audit tiers:
   - Tier 1: `npm run test:preflight` (10/10 production checks)
   - Tier 2: `npm run test:audit` (183/183 component & subsystem tests)
   - Tier 3: `npm run test:ddia` (11/11 DDIA distributed systems benchmarks)
   - Tier 4: `node tests/chaos-resilience-suite.mjs` (12/12 socket leak & client abort tests)
   - Tier 5: `node tests/adversarial-exploit-harness.mjs` (10 adversarial Node.js exploit attacks)
   - Tier 6: `npm run test:showcase` (18/18 live multi-backend mock demonstration)

2. **Exploit Surface Areas to Inspect**:
   - **IPC Queue Backpressure**: Master-to-worker IPC pipe saturation handling via `workerSend()` queueing.
   - **Socket & Client Abort Leaks**: `c.res.on('close')` triggering `ABORT_REQUEST` to prevent socket starvation.
   - **Circuit Breaker Probe Neutrality**: Neutral `cancelProbe()` on bulkhead/worker exhaustion.
   - **Idempotency Guards**: Block retrying `POST`/`PUT`/`DELETE` on 5xx unless `Idempotency-Key` is present.
   - **Memory Safety**: 50k LRU stores and bounded buffers on streaming bodies.

3. **Constraints**:
   - **ZERO deletions**: Do not delete any existing files, tests, or features.
   - Keep 100% test pass rate across all suites.
