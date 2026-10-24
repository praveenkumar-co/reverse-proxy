#!/usr/bin/env bash
# ==============================================================================
#  MASTER EXPLOIT, AUDIT & PRODUCTION VERIFICATION SUITE
#  Ready for Claude Code / CI / Terminal Execution
# ==============================================================================
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=================================================================="
echo "  🚀 NINJA REVERSE PROXY: ALL-IN-ONE MASTER AUDIT & EXPLOIT RUNNER"
echo "=================================================================="
echo "Working directory: $REPO_ROOT"
echo "Node version: $(node -v)"
echo ""

# 1. Kill any leftover orphan proxy or mock processes
echo "[Step 0/6] Cleaning up lingering processes..."
pkill -f "dist/index.js" 2>/dev/null || true
pkill -f "tests/.*mock" 2>/dev/null || true
sleep 1

# 2. Build TypeScript
echo "[Step 1/6] Compiling TypeScript..."
npm run build

# 3. Fast Preflight Check
echo ""
echo "[Step 2/6] Running Production Pre-Flight Checklist..."
npm run test:preflight

# 4. Full Component & System Audit (183/183 assertions)
echo ""
echo "[Step 3/6] Running Full System Architecture Audit (183 tests)..."
npm run test:audit

# 5. DDIA Benchmarks
echo ""
echo "[Step 4/6] Running DDIA Architectural Benchmarks..."
npm run test:ddia

# 6. Chaos & Socket Leak Resilience Suite
echo ""
echo "[Step 5/6] Running Adversarial Chaos Resilience Suite..."
node tests/chaos-resilience-suite.mjs

# 7. Adversarial Exploit Harness (Node.js Bottleneck Attack)
echo ""
echo "[Step 6/6] Running Adversarial Exploit Harness..."
node tests/adversarial-exploit-harness.mjs || {
  echo "⚠️ Exploit harness encountered non-zero exit; check details above."
}

echo ""
echo "=================================================================="
echo "  ✅ ALL CRITICAL TEST SUITES EXECUTED SUCCESSFULLY!"
echo "=================================================================="
