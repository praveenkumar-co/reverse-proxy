#!/bin/bash
# Phase G full-gate runner. Runs every suite in the mandated order, captures stdout+stderr
# per suite to its own log, and records exit code (via PIPESTATUS, never $? after a pipe)
# plus a best-effort pass-count extraction into a single summary file.
#
# Hardening added after a real incident in this phase: a partial mock-upstream startup
# failure in tests/datapath-regression.mjs left servers orphaned, holding ports 4701-4715,
# which then made every subsequent run of that suite (and scripts/deep-architecture-audit.mjs,
# which spawns it) fail or hang. Fixed at the source in each test file; this script adds two
# more layers so a leak anywhere still fails loudly instead of silently corrupting the next
# suite or run: a port-free check before every suite, and a hard per-suite timeout (GNU
# `timeout`/`gtimeout` isn't installed on this machine, so implemented portably below).
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
OUT_DIR="${1:-/tmp/phase-g-gate-logs}"
SUMMARY="${2:-/tmp/phase-g-gate-summary.txt}"
mkdir -p "$OUT_DIR"
: > "$SUMMARY"

# Ports no suite should ever find already bound at its own start -- datapath-regression.mjs's
# full mock-upstream range (the one actually involved in the incident) plus the generic
# proxy/soak process patterns used elsewhere in this repo's own orphan-check convention.
PORTS_TO_CHECK="4701 4702 4703 4704 4705 4706 4707 4708 4709 4710 4711 4712 4713 4714 4715 4720 4721 8595 4730 8540 8543 8550 8553 8560 8563 8570 8573 8580 8590 4740 4741 4742"
ORPHAN_PATTERN="dist/index\.js|redis-server|nginx|wrk|bench/|soak"

check_ports_free() {
  local name="$1"
  local busy=""
  for port in $PORTS_TO_CHECK; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      busy="$busy $port"
    fi
  done
  local orphans
  orphans=$(pgrep -fl "$ORPHAN_PATTERN" 2>/dev/null)
  if [ -n "$busy" ] || [ -n "$orphans" ]; then
    {
      echo "=== $name ==="
      echo "FATAL: pre-suite check failed -- ports/processes from a previous run are still alive."
      [ -n "$busy" ] && echo "  busy ports:$busy"
      [ -n "$orphans" ] && echo "  orphan processes:" && echo "$orphans" | sed 's/^/    /'
      echo "  Refusing to start $name against a contaminated environment. Investigate and kill"
      echo "  these manually, then re-run the gate -- do NOT auto-kill here, since that could"
      echo "  mask a real leak this check exists to catch."
    } | tee -a "$SUMMARY"
    return 1
  fi
  return 0
}

# Portable per-suite hard timeout: backgrounds the command, polls for completion, and
# SIGTERMs (then SIGKILLs if it doesn't die within 10s) the whole process group if the
# deadline passes -- this machine has neither GNU `timeout` nor `gtimeout` installed.
run_with_timeout() {
  local timeout_secs="$1"
  local logfile="$2"
  shift 2
  ( "$@" > "$logfile" 2>&1 ) &
  local cmd_pid=$!
  local waited=0
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if [ "$waited" -ge "$timeout_secs" ]; then
      echo "TIMEOUT after ${timeout_secs}s -- sending SIGTERM to pid $cmd_pid" >> "$logfile"
      kill -TERM "$cmd_pid" 2>/dev/null
      sleep 10
      if kill -0 "$cmd_pid" 2>/dev/null; then
        echo "still alive after SIGTERM -- SIGKILL" >> "$logfile"
        kill -KILL "$cmd_pid" 2>/dev/null
      fi
      wait "$cmd_pid" 2>/dev/null
      return 124
    fi
    sleep 2
    waited=$((waited + 2))
  done
  wait "$cmd_pid"
  return $?
}

run_suite() {
  local name="$1"
  local timeout_secs="$2"
  shift 2
  local logfile="$OUT_DIR/${name}.log"
  echo "=== $name ===" | tee -a "$SUMMARY"
  if ! check_ports_free "$name"; then
    echo "exit_code=skipped-contaminated-environment" | tee -a "$SUMMARY"
    echo "" | tee -a "$SUMMARY"
    return 1
  fi
  run_with_timeout "$timeout_secs" "$logfile" "$@"
  local code=$?
  echo "exit_code=$code" | tee -a "$SUMMARY"
  # Best-effort pass-count extraction across the different suite output styles seen in this repo.
  local passline
  passline=$(grep -iE "^# pass [0-9]+|PASSED|RESULT:.*PASSED|Total Passed:|TOTAL:.*assertions passed|passed" "$logfile" | tail -5)
  echo "$passline" | sed 's/^/  /' | tee -a "$SUMMARY"
  echo "  (full log: $logfile)" | tee -a "$SUMMARY"
  echo "" | tee -a "$SUMMARY"
}

run_suite "build" 300 npm run build
run_suite "unit-test" 300 npm test
run_suite "full-system-audit" 300 node tests/full-system-audit.mjs
run_suite "datapath-regression" 300 node tests/datapath-regression.mjs
run_suite "access-log-integrity" 120 node tests/access-log-integrity.mjs --duration-ms 30000
run_suite "tls-e2e" 180 node tests/tls-e2e.mjs
run_suite "ssrf-admin" 120 node tests/ssrf-admin.mjs
run_suite "production-gates" 300 node tests/production-gates.mjs
run_suite "production-preflight-check" 300 node tests/production-preflight-check.mjs
run_suite "chaos-resilience-suite" 300 node tests/chaos-resilience-suite.mjs
run_suite "executive-showcase-suite" 300 node tests/executive-showcase-suite.mjs
run_suite "test-fire" 300 npm run test:fire
run_suite "ddia-benchmarks-test" 300 node tests/ddia-benchmarks-test.mjs
run_suite "ddia-transactions-suite" 300 node tests/ddia-transactions-suite.mjs
run_suite "rate-limit-redis-verification" 300 node tests/rate-limit-redis-verification.mjs
run_suite "check-test-integrity" 300 node scripts/check-test-integrity.mjs
run_suite "audit-arch" 600 npm run audit:arch

echo "=== GATE COMPLETE ===" | tee -a "$SUMMARY"
