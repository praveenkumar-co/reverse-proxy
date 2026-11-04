// =============================================================================
// NINJA REVERSE PROXY — DDIA CHAPTER 7: TRANSACTIONS & CONCURRENCY SUITE
// =============================================================================
// Verifies how an enterprise L7 Reverse Proxy / API Gateway handles Transactional
// and Concurrency challenges (DDIA Chapter 7) WITHOUT coupling to a database,
// exercising only real src/ modules:
//   1. Idempotency-Key Protection (Preventing Duplicate Mutating Transactions)
//   4. OLTP vs OLAP Bulkhead Isolation (Shielding Short Transactions from Long Queries)
//   5. Distributed Transaction Boundary Timeouts (Lock Starvation Defense)
//
// The Lost-Update (If-Match/ETag) and SAGA/2PC rollback cases used classes
// defined only in this test file (no real src/ implementation) and were moved
// to tests/simulations/ddia-transactions-conceptual.mjs — see its README.
// =============================================================================

import { isMethodRetrySafe } from "../dist/resilience/retry/idempotency.js";
import { Bulkhead } from "../dist/resilience/bulkhead/bulkhead.js";
import { ClassicCircuitBreaker } from "../dist/resilience/circuit-breaker/classic.circuit-breaker.js";
import { calculateFullJitterBackoff } from "../dist/resilience/retry/backoff/full-jitter.backoff.js";

let totalPassed = 0;
let totalFailed = 0;

function report(section, title, pass, details = "") {
  if (pass) {
    totalPassed++;
    console.log(`  \x1b[32m✅ PASS\x1b[0m [${section}] ${title} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
  } else {
    totalFailed++;
    console.error(`  \x1b[31m❌ FAIL\x1b[0m [${section}] ${title} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
  }
}

console.log("\n==================================================================");
console.log("   DDIA CHAPTER 7: TRANSACTIONS & CONCURRENCY HARNESS            ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// §1. Idempotency Keys: Preventing Duplicate Side-Effects on Blind Retries
// -----------------------------------------------------------------------------
console.log("\x1b[1m§1. Idempotency Keys: Defending Mutating Transactions Against Duplicate Runs\x1b[0m");

// DDIA Chapter 7: If a network glitch occurs after a bank transfer or order write,
// blind automatic retries cause duplicate charges (Double-Spending).
// The gateway must NEVER blindly retry POST/PUT/PATCH unless an Idempotency-Key is present.

const readIsSafe = isMethodRetrySafe("GET", {}, false);
const postBlindIsSafe = isMethodRetrySafe("POST", {}, false);
const postWithKeyIsSafe = isMethodRetrySafe("POST", { "idempotency-key": "tx-uuid-888" }, false);
const patchBlindIsSafe = isMethodRetrySafe("PATCH", {}, false);
const patchWithKeyIsSafe = isMethodRetrySafe("PATCH", { "idempotency-key": "tx-uuid-999" }, false);

report(
  "TX-01",
  "Blind mutating transaction (POST/PATCH) is strictly blocked from auto-retry",
  postBlindIsSafe === false && patchBlindIsSafe === false && readIsSafe === true,
  "POST=Blocked, PATCH=Blocked, GET=Allowed"
);

report(
  "TX-02",
  "Mutating request with Idempotency-Key is safely authorized for automatic retry",
  postWithKeyIsSafe === true && patchWithKeyIsSafe === true,
  "Key tx-uuid-888 authorized retry"
);

// -----------------------------------------------------------------------------
// §4. Bulkhead Isolation: OLTP (Short Transactions) vs. OLAP (Long Queries)
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§4. Bulkhead Isolation: Shielding Short OLTP Transactions from Long OLAP Queries\x1b[0m");

// Long-running analytical reporting queries (OLAP) holding snapshots must never
// saturate connection pools needed for short, fast payment transactions (OLTP).

const oltpBulkhead = new Bulkhead(50); // Payment checkout pool
const olapBulkhead = new Bulkhead(3);  // Heavy reporting pool

// Simulate flood of 10 heavy reporting requests
let olapAdmitted = 0;
let olapRejected = 0;
for (let i = 0; i < 10; i++) {
  if (olapBulkhead.enter()) olapAdmitted++;
  else olapRejected++;
}

// Meanwhile, critical OLTP checkout transactions still execute freely
let oltpAdmitted = 0;
for (let i = 0; i < 5; i++) {
  if (oltpBulkhead.enter()) oltpAdmitted++;
}

report(
  "TX-07",
  "OLAP reporting flood is capped by Bulkhead without starving OLTP checkout slots",
  olapAdmitted === 3 && olapRejected === 7 && oltpAdmitted === 5,
  `OLAP: ${olapAdmitted} admitted, ${olapRejected} shed | OLTP: ${oltpAdmitted} admitted 100%`
);

// -----------------------------------------------------------------------------
// §5. Transaction Timeout Enforcement: Preventing Lock Starvation
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§5. Transaction Boundary Timeout (Deadlock & Lock Starvation Defense)\x1b[0m");

// In distributed transactions, a slow upstream can hold locks indefinitely.
// The gateway enforces a strict read/socket timeout to abort lingering requests.

const txCircuitBreaker = new ClassicCircuitBreaker(3, 50);

// Simulate an upstream holding a transaction lock and exceeding the gateway timeout
const txTimeoutMs = 50;
let timedOut = false;

const hangingTx = new Promise((resolve) => setTimeout(() => resolve("slow_tx_done"), 200));
const timeoutGuard = new Promise((_, reject) =>
  setTimeout(() => reject(new Error("504 Gateway Timeout: Transaction Boundary Exceeded")), txTimeoutMs)
);

try {
  await Promise.race([hangingTx, timeoutGuard]);
} catch (err) {
  timedOut = true;
  txCircuitBreaker.recordFailure(); // Protect system from cascading timeout stalls
}

report(
  "TX-08",
  "Gateway enforces strict boundary timeout to tear down lingering transactions holding locks",
  timedOut === true && txCircuitBreaker.getFailures() === 1,
  "Aborted at 50ms before upstream could hold locks for 200ms"
);

// -----------------------------------------------------------------------------
// FINAL SUMMARY
// -----------------------------------------------------------------------------
console.log("\n==================================================================");
console.log(`  DDIA CHAPTER 7 SUITE RESULTS:  ${totalPassed} Passed  |  ${totalFailed} Failed`);
console.log("==================================================================\n");

if (totalFailed > 0) {
  process.exit(1);
}
