#!/usr/bin/env bash
# ==============================================================================
#  MASTER EXPLOIT, AUDIT & PRODUCTION VERIFICATION SUITE
#  Ready for Claude Code / CI / Terminal Execution
# ==============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=================================================================="
echo "  🚀 NINJA REVERSE PROXY: ALL-IN-ONE MASTER AUDIT & EXPLOIT RUNNER"
echo "=================================================================="
echo "Working directory: $REPO_ROOT"
echo "Node version: $(node -v)"
echo ""

# Process Cleanup
echo "[Step 0/6] Cleaning up lingering processes..."
pkill -f "dist/index.js" 2>/dev/null || true
pkill -f "tests/.*mock" 2>/dev/null || true
sleep 1

RESULTS=()

run_tier() {
  local num="$1"
  local name="$2"
  local cmd="$3"

  echo ""
  echo "=================================================================="
  echo "  [Tier $num/6] $name"
  echo "  Command: $cmd"
  echo "=================================================================="
  if eval "$cmd"; then
    RESULTS+=("✅ Tier $num: $name -> PASSED")
  else
    RESULTS+=("❌ Tier $num: $name -> FAILED")
  fi
}

# 1. Build TypeScript
run_tier 1 "TypeScript Compilation" "npm run build"

# 2. Fast Pre-Flight Check (10 checks)
run_tier 2 "Production Pre-Flight Checklist" "npm run test:preflight"

# 3. Full System Architecture Audit (183 tests)
run_tier 3 "Full Architecture & Services Audit" "npm run test:audit"

# 4. Traffic Management & Resilience Benchmarks (11 tests)
run_tier 4 "Traffic Management & Resilience Benchmarks" "npm run test:ddia"

# 5. Adversarial Chaos Resilience (12 tests)
run_tier 5 "Chaos & Socket Leak Resilience Suite" "node tests/chaos-resilience-suite.mjs"

# 6. Adversarial Exploit Harness (10 exploit attacks)
run_tier 6 "Adversarial Exploit Harness" "node tests/adversarial-exploit-harness.mjs"

# Cleanup at the end
pkill -f "dist/index.js" 2>/dev/null || true
pkill -f "tests/.*mock" 2>/dev/null || true

echo ""
echo "=================================================================="
echo "  📊 FINAL SCORECARD SUMMARY"
echo "=================================================================="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo "=================================================================="
