// =============================================================================
// DDIA CHAPTER 7 — CONCEPTUAL MODELS (NOT PROXY TESTS)
// =============================================================================
// These cases model distributed-transaction concepts from DDIA Chapter 7 using
// classes defined entirely in this file. They do not exercise any code under
// src/ and must never be counted toward the proxy's test totals. See README.md
// in this directory.
//
// Moved out of tests/ddia-transactions-suite.mjs (Phase E, test-integrity pass):
//   - PreconditionGateway / §3 Lost Update Defense (If-Match / ETag)
//   - DistributedSagaCoordinator / §6 SAGA / 2PC Rollback
// =============================================================================

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
console.log("   DDIA CHAPTER 7 CONCEPTUAL MODELS (simulation, not proxy code)  ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// §3. Preventing Lost Updates via Conditional Headers (RFC 7232) — conceptual
// -----------------------------------------------------------------------------
console.log("\x1b[1m§3. Lost Update Defense: If-Match / ETag Precondition Checking (conceptual)\x1b[0m");

class PreconditionGateway {
  constructor() {
    this.resourceEtags = new Map([["doc_101", "etag-v2"]]); // Current server state is v2
  }

  handleMutation(docId, ifMatchHeader, newContent) {
    const currentEtag = this.resourceEtags.get(docId);
    if (!currentEtag) return { status: 404 };

    if (ifMatchHeader && ifMatchHeader !== currentEtag) {
      return {
        status: 412,
        error: "Precondition Failed: Resource has been modified by another transaction (Lost Update Prevented)",
      };
    }

    const nextEtag = `etag-v${parseInt(currentEtag.replace("etag-v", "")) + 1}`;
    this.resourceEtags.set(docId, nextEtag);
    return { status: 200, etag: nextEtag, content: newContent };
  }
}

const occGateway = new PreconditionGateway();
const staleUpdate = occGateway.handleMutation("doc_101", "etag-v1", "Alice's Stale Text");
const validUpdate = occGateway.handleMutation("doc_101", "etag-v2", "Bob's Fresh Text");

report(
  "TX-05",
  "Gateway stops Lost Update anomaly by returning 412 Precondition Failed on stale ETag",
  staleUpdate.status === 412,
  `Status: ${staleUpdate.status} (Lost update aborted before DB)`
);

report(
  "TX-06",
  "Mutation with matching ETag succeeds and advances version watermark",
  validUpdate.status === 200 && validUpdate.etag === "etag-v3",
  `Status: 200, New ETag: ${validUpdate.etag}`
);

// -----------------------------------------------------------------------------
// §6. All-or-Nothing SAGA / 2PC Distributed Rollback — conceptual
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§6. Distributed Transaction Atomicity: All-or-Nothing Rollback (conceptual)\x1b[0m");

class DistributedSagaCoordinator {
  constructor() {
    this.inventoryReserved = false;
    this.billingCharged = false;
  }

  async executeTransaction(shouldBillingFail = false) {
    this.inventoryReserved = true;

    if (shouldBillingFail) {
      this.inventoryReserved = false; // Compensating rollback
      return { success: false, error: "Billing Failed: Inventory reservation rolled back" };
    }

    this.billingCharged = true;
    return { success: true };
  }
}

const saga = new DistributedSagaCoordinator();
const failedTx = await saga.executeTransaction(true);

report(
  "TX-09",
  "Distributed multi-service transaction guarantees Atomicity via compensating rollback",
  failedTx.success === false && saga.inventoryReserved === false && saga.billingCharged === false,
  "Inventory reservation undone after billing error — 0 partial writes"
);

const successTx = await saga.executeTransaction(false);

report(
  "TX-10",
  "Successful distributed transaction commits both participants atomically",
  successTx.success === true && saga.inventoryReserved === true && saga.billingCharged === true,
  "Inventory and billing committed together"
);

// -----------------------------------------------------------------------------
// FINAL SUMMARY
// -----------------------------------------------------------------------------
console.log("\n==================================================================");
console.log(`  DDIA CHAPTER 7 CONCEPTUAL RESULTS:  ${totalPassed} Passed  |  ${totalFailed} Failed`);
console.log("==================================================================\n");

if (totalFailed > 0) {
  process.exit(1);
}
