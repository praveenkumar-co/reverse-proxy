#!/usr/bin/env bash
# =============================================================================
# cleanup.sh — verified dead-code removal for ninja-reverse-proxy
#
# Based on the architectural audit of commit eedd8ff (2026-10-28).
#
#   Phase a : 23 source files with no importer anywhere + 9 committed test
#             leftovers. No test edits needed. Verified: build, 183/183 audit,
#             115/115 unit/integration tests pass after removal.
#   Phase b : 6 source files used only by test cases that exercise code the
#             proxy never runs. Removes those test cases (by marker, not line
#             number) together with the files.
#
# Usage:
#   scripts/cleanup.sh --phase a [--dry-run] [--no-verify]
#   scripts/cleanup.sh --phase b [--dry-run] [--no-verify]
#
# Safety:
#   - Refuses to run on a dirty working tree, so a failed run can be rolled
#     back to HEAD without losing your work.
#   - Every edit is checked: a missing marker or file aborts before changes.
#   - After changes it runs build + tests; on failure it rolls back to HEAD.
#   - It never commits. Review with `git diff --staged` and commit yourself.
# =============================================================================
set -euo pipefail

PHASE=""
DRY_RUN=0
VERIFY=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)     PHASE="${2:-}"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$PHASE" == "a" || "$PHASE" == "b" ]] || { echo "Specify --phase a or --phase b" >&2; exit 2; }

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }

# ── Preflight ────────────────────────────────────────────────────────────────
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { red "Not inside a git repository."; exit 1; }
cd "$ROOT"
grep -q '"name": "ninja-reverse-proxy"' package.json || { red "package.json is not ninja-reverse-proxy; aborting."; exit 1; }

if [[ $DRY_RUN -eq 0 && -n "$(git status --porcelain)" ]]; then
  red "Working tree is not clean. Commit or stash first, so rollback is safe."
  git status --short
  exit 1
fi

# ── File lists ───────────────────────────────────────────────────────────────
PHASE_A_SRC=(
  src/balancer/contracts/context.types.ts
  src/config/config-schema.ts
  src/config/config.ts
  src/config/server-schema.ts
  src/core/proxy/http.handler.ts
  src/core/proxy/upstream.client.ts
  src/core/router/router.ts
  src/discovery/target-node.ts
  src/middleware/cache.middleware.ts
  src/middleware/circuit.middleware.ts
  src/middleware/fencing.middleware.ts
  src/middleware/logging.middleware.ts
  src/middleware/rate-limit.middleware.ts
  src/ratelimit/contracts/limiter.interface.ts
  src/ratelimit/storage/redis.store.ts
  src/resilience/circuit-breaker/states/closed.state.ts
  src/resilience/circuit-breaker/states/half-open.state.ts
  src/resilience/circuit-breaker/states/open.state.ts
  src/types/common.types.ts
  src/types/config.types.ts
  src/types/http.types.ts
  src/types/index.ts
  src/types/resilience.types.ts
)
PHASE_A_ROOT=(
  _adv_cfg_9701.yaml _adv_cfg_9702.yaml _adv_cfg_9704.yaml _adv_cfg_9705.yaml
  _adv_cfg_9706.yaml _adv_cfg_9707.yaml _adv_cfg_9708.yaml _adv_cfg_9709.yaml
  _adv_cfg_9710.yaml
)
# barrel file | exact line to remove
PHASE_A_BARREL_EDITS=(
  "src/discovery/index.ts|export * from './target-node.js';"
  "src/ratelimit/index.ts|export type { ILimiter } from './contracts/limiter.interface.js';"
  "src/ratelimit/index.ts|export { RedisStore } from './storage/redis.store.js';"
)
# README tree lines that describe deleted files (matched by substring)
PHASE_A_README_PATTERNS=(
  "http.handler.ts                # HTTP request streaming"
  "upstream.client.ts             # Upstream client request dispatcher"
  "states/                        # Circuit breaker states"
  "closed.state.ts            # ClosedState"
  "half-open.state.ts         # HalfOpenState"
  "open.state.ts              # OpenState"
)

PHASE_B_SRC=(
  src/ratelimit/contracts/storage.interface.ts
  src/ratelimit/storage/hybrid.store.ts
  src/ratelimit/storage/memory.store.ts
  src/resilience/retry/contracts/retry.interface.ts
  src/resilience/retry/policies/idempotent.policy.ts
  src/resilience/retry/retry-handler.ts
)
PHASE_B_BARREL_EDITS=(
  "src/ratelimit/index.ts|export type { IRateLimitStore } from './contracts/storage.interface.js';"
  "src/ratelimit/index.ts|export { MemoryStore } from './storage/memory.store.js';"
  "src/ratelimit/index.ts|export { HybridStore } from './storage/hybrid.store.js';"
  "src/resilience/index.ts|export * from './retry/retry-handler.js';"
  "src/resilience/index.ts|export type { IRetryPolicy } from './retry/contracts/retry.interface.js';"
)

# ── Helpers ──────────────────────────────────────────────────────────────────
rollback() {
  red "Verification failed — rolling back to HEAD."
  git reset --hard HEAD >/dev/null
  git clean -fdq -- src tests
  red "Rolled back. Nothing was changed."
  exit 1
}

require_files() {
  local missing=0
  for f in "$@"; do [[ -e "$f" ]] || { red "Missing: $f"; missing=1; }; done
  [[ $missing -eq 0 ]] || { red "Expected files are missing (already pruned, or a different commit). Aborting."; exit 1; }
}

require_lines() {
  local missing=0
  for e in "$@"; do
    local file="${e%%|*}" line="${e#*|}"
    grep -qxF -- "$line" "$file" || { red "Line not found in $file: $line"; missing=1; }
  done
  [[ $missing -eq 0 ]] || { red "Barrel files differ from the audited commit. Aborting."; exit 1; }
}

remove_lines() {
  for e in "$@"; do
    local file="${e%%|*}" line="${e#*|}"
    LINE="$line" node -e '
      const fs = require("fs"); const f = process.argv[1];
      const out = fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== process.env.LINE);
      fs.writeFileSync(f, out.join("\n"));' "$file"
  done
}

# Remove a block of a test file between two marker lines.
# The start marker must occur exactly once; the block ends at the first line
# equal to the end marker after it. Start line removed, end line kept.
remove_block() {
  local file="$1" start="$2" end="$3"
  START="$start" END="$end" node -e '
    const fs = require("fs"); const f = process.argv[1];
    const lines = fs.readFileSync(f, "utf8").split("\n");
    const idx = (m) => lines.reduce((a, l, i) => (l === m ? [...a, i] : a), []);
    const s = idx(process.env.START);
    const end = s.length === 1 ? lines.findIndex((l, i) => i > s[0] && l === process.env.END) : -1;
    if (s.length !== 1 || end < 0) {
      console.error(`Marker check failed in ${f}: start found x${s.length}, end found=${end >= 0}`); process.exit(1);
    }
    lines.splice(s[0], end - s[0]);
    fs.writeFileSync(f, lines.join("\n"));' "$file"
}

remove_import_lines() {
  local file="$1"; shift
  for frag in "$@"; do
    FRAG="$frag" node -e '
      const fs = require("fs"); const f = process.argv[1];
      const lines = fs.readFileSync(f, "utf8").split("\n");
      const hits = lines.filter((l) => l.startsWith("import ") && l.includes(process.env.FRAG));
      if (hits.length !== 1) { console.error(`Expected 1 import of ${process.env.FRAG} in ${f}, found ${hits.length}`); process.exit(1); }
      fs.writeFileSync(f, lines.filter((l) => l !== hits[0]).join("\n"));' "$file"
  done
}

verify() {
  info "npm run build"
  npm run -s build || return 1
  info "npm test (unit + integration)"
  npm test 2>&1 | tail -n 8 | grep -q "^# fail 0" || { npm test 2>&1 | tail -n 20; return 1; }
  info "full-system-audit"
  node tests/full-system-audit.mjs > /tmp/cleanup-audit.log 2>&1 || { tail -n 30 /tmp/cleanup-audit.log; return 1; }
  grep -a "RESULT" /tmp/cleanup-audit.log | sed 's/\x1b\[[0-9;]*m//g'
  if [[ "$PHASE" == "b" ]]; then
    info "ddia-transactions-suite"
    node tests/ddia-transactions-suite.mjs > /tmp/cleanup-tx.log 2>&1 || { tail -n 30 /tmp/cleanup-tx.log; return 1; }
    grep -a "SUITE RESULTS" /tmp/cleanup-tx.log | sed 's/\x1b\[[0-9;]*m//g'
  fi
  info "audit:arch dead-file count"
  local dead
  dead="$(node scripts/deep-architecture-audit.mjs 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'DEAD CODE[^:]*:[[:space:]]+[0-9]+' | grep -oE '[0-9]+$' || echo '?')"
  echo "    dead files reported: $dead"
  [[ "$dead" == "0" ]] || return 1
}

# ── Phase a ──────────────────────────────────────────────────────────────────
phase_a() {
  require_files "${PHASE_A_SRC[@]}"
  require_lines "${PHASE_A_BARREL_EDITS[@]}"

  info "Phase a: ${#PHASE_A_SRC[@]} source files, ${#PHASE_A_ROOT[@]} root leftovers, ${#PHASE_A_BARREL_EDITS[@]} barrel lines"
  printf '    delete %s\n' "${PHASE_A_SRC[@]}"
  for f in "${PHASE_A_ROOT[@]}"; do [[ -e "$f" ]] && printf '    delete %s\n' "$f"; done
  [[ $DRY_RUN -eq 1 ]] && { green "Dry run: nothing changed."; return; }

  git rm -q -- "${PHASE_A_SRC[@]}"
  for f in "${PHASE_A_ROOT[@]}"; do [[ -e "$f" ]] && git rm -q -- "$f"; done
  remove_lines "${PHASE_A_BARREL_EDITS[@]}"

  for p in "${PHASE_A_README_PATTERNS[@]}"; do
    [[ "$(grep -cF -- "$p" README.md || true)" == "1" ]] || echo "    note: README pattern not matched exactly once, left as is: $p"
    PAT="$p" node -e '
      const fs = require("fs");
      const out = fs.readFileSync("README.md", "utf8").split("\n").filter((l) => !l.includes(process.env.PAT));
      fs.writeFileSync("README.md", out.join("\n"));'
  done

  grep -qxF '_*_cfg_*.yaml' .gitignore || printf '\n_*_cfg_*.yaml\n' >> .gitignore
  git add -A -- src README.md .gitignore
}

# ── Phase b ──────────────────────────────────────────────────────────────────
phase_b() {
  require_files "${PHASE_B_SRC[@]}" tests/full-system-audit.mjs tests/ddia-transactions-suite.mjs
  require_lines "${PHASE_B_BARREL_EDITS[@]}"

  info "Phase b: ${#PHASE_B_SRC[@]} source files, ${#PHASE_B_BARREL_EDITS[@]} barrel lines, 2 test files edited"
  printf '    delete %s\n' "${PHASE_B_SRC[@]}"
  echo   "    tests/full-system-audit.mjs: remove 3 imports, RetryHandler block (3 cases), MemoryStore + HybridStore block (6 cases)"
  echo   "    tests/ddia-transactions-suite.mjs: remove 2 imports, section 2 (TX-03, TX-04)"
  [[ $DRY_RUN -eq 1 ]] && { green "Dry run: nothing changed."; return; }

  local FSA=tests/full-system-audit.mjs TX=tests/ddia-transactions-suite.mjs
  remove_import_lines "$FSA" "retry/retry-handler.js" "storage/memory.store.js" "storage/hybrid.store.js"
  remove_block "$FSA" "// RetryHandler" "// Jitter Backoffs"
  remove_block "$FSA" "// MemoryStore" "// ============================================================================="
  remove_import_lines "$TX" "retry/retry-handler.js" "policies/idempotent.policy.js"
  remove_block "$TX" \
    "// §2. Optimistic Concurrency Control (OCC) & 409 WriteConflict Retries" \
    "// §3. Preventing Lost Updates at Gateway Layer via Conditional Headers (RFC 7232)"
  node --check "$FSA" && node --check "$TX"

  if grep -rnE "retry-handler|storage/(memory|hybrid)\.store|idempotent\.policy|retry\.interface|storage\.interface" tests; then
    red "Tests still reference phase-b modules (above). Aborting."; git reset --hard HEAD >/dev/null; exit 1
  fi

  git rm -q -- "${PHASE_B_SRC[@]}"
  remove_lines "${PHASE_B_BARREL_EDITS[@]}"
  git add -A -- src tests
}

# ── Run ──────────────────────────────────────────────────────────────────────
"phase_$PHASE"
[[ $DRY_RUN -eq 1 ]] && exit 0

if [[ $VERIFY -eq 1 ]]; then
  verify || rollback
fi

green "Phase $PHASE complete. Changes are staged, not committed."
git status --short
echo
echo "Next: review with 'git diff --staged', then commit, e.g.:"
echo "  git commit -m \"chore: prune dead code (cleanup phase $PHASE)\""
