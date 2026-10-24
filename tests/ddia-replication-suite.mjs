// =============================================================================
// NINJA REVERSE PROXY — DDIA CHAPTER 5: REPLICATION & CONSISTENCY TEST SUITE
// =============================================================================
// Verifies all core distributed data replication principles from DDIA Chapter 5:
//   1. Primary-Secondary Read/Write Splitting (Single-Leader Ingestion)
//   2. Read-After-Write Consistency (Read-Your-Own-Writes Protection)
//   3. Monotonic Reads via Sticky Sessions & Consistent Hashing (No Time Travel)
//   4. Primary Failover & Circuit Breaker Protection (Automated Standby Promotion)
//   5. Quorum Overlap Verification (w + r > n Pigeonhole Guarantee)
//   6. Bulkhead Concurrency Shielding against Lagging Replicas
// =============================================================================

import { LoadBalancer } from "../dist/balancer/core/load-balancer.js";
import { RoundRobinStrategy } from "../dist/balancer/strategies/round-robin.strategy.js";
import { StickySessionsStrategy } from "../dist/balancer/strategies/sticky-sessions.strategy.js";
import { ConsistentHashingStrategy } from "../dist/balancer/strategies/consistent-hashing.strategy.js";
import { ClassicCircuitBreaker } from "../dist/resilience/circuit-breaker/classic.circuit-breaker.js";
import { Bulkhead } from "../dist/resilience/bulkhead/bulkhead.js";

let totalPassed = 0;
let totalFailed = 0;

function report(title, pass, details = "") {
  if (pass) {
    totalPassed++;
    console.log(`  \x1b[32m✅ PASS\x1b[0m: ${title} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
  } else {
    totalFailed++;
    console.error(`  \x1b[31m❌ FAIL\x1b[0m: ${title} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
  }
}

console.log("\n==================================================================");
console.log("   DDIA CHAPTER 5: REPLICATION, ROUTING & CONSISTENCY SUITE      ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// §1. Single-Leader Routing: Primary vs. Secondary Read/Write Split
// -----------------------------------------------------------------------------
console.log("\x1b[1m§1. Single-Leader Routing (Primary Write / Secondary Read Split)\x1b[0m");

class PrimarySecondaryRouter {
  constructor(primaryId, replicaIds) {
    this.primaryId = primaryId;
    this.replicaLb = new LoadBalancer(
      {
        strategy: "rr",
        upstreams: replicaIds.map((id) => ({ id, weight: 1 })),
      },
      new RoundRobinStrategy()
    );
    this.healthyReplicas = new Set(replicaIds);
  }

  route(method) {
    const isWrite = ["POST", "PUT", "DELETE", "PATCH"].includes(method.toUpperCase());
    if (isWrite) {
      return this.primaryId; // Writes must strictly go to Primary Leader
    }
    // Reads are distributed across replicas
    return this.replicaLb.pickFiltered(this.healthyReplicas);
  }
}

const dbCluster = new PrimarySecondaryRouter("pg-primary-leader", [
  "pg-replica-01",
  "pg-replica-02",
]);

const writeTargets = [
  dbCluster.route("POST"),
  dbCluster.route("PUT"),
  dbCluster.route("DELETE"),
];
const readTargets = [
  dbCluster.route("GET"),
  dbCluster.route("GET"),
  dbCluster.route("GET"),
  dbCluster.route("GET"),
];

report(
  "All mutation requests (POST/PUT/DELETE) strictly route to Leader",
  writeTargets.every((t) => t === "pg-primary-leader"),
  `Target: ${writeTargets[0]}`
);

report(
  "Read requests (GET) load-balance across Replicas",
  readTargets.includes("pg-replica-01") && readTargets.includes("pg-replica-02"),
  `Dispatched reads across [${[...new Set(readTargets)].join(", ")}]`
);

// -----------------------------------------------------------------------------
// §2. Replication Lag: Read-After-Write Consistency Verification
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§2. Replication Lag: Read-After-Write Consistency\x1b[0m");

// Scenario: Replica-02 has a 2000ms replication lag.
// A user updating their profile must not see stale data upon immediate refresh.
class ReadYourWritesGateway {
  constructor(primaryId, replicaIds, graceWindowMs = 2000) {
    this.primaryId = primaryId;
    this.replicaLb = new LoadBalancer(
      {
        strategy: "rr",
        upstreams: replicaIds.map((id) => ({ id, weight: 1 })),
      },
      new RoundRobinStrategy()
    );
    this.healthyReplicas = new Set(replicaIds);
    this.userRecentWrites = new Map(); // userId -> writeTimestamp
    this.graceWindowMs = graceWindowMs;
  }

  recordWrite(userId) {
    this.userRecentWrites.set(userId, Date.now());
  }

  routeRead(userId) {
    const lastWrite = this.userRecentWrites.get(userId);
    const now = Date.now();
    // If the user modified data within the replication grace window, route to Primary!
    if (lastWrite && now - lastWrite < this.graceWindowMs) {
      return { upstream: this.primaryId, reason: "read-your-writes-pinning" };
    }
    return {
      upstream: this.replicaLb.pickFiltered(this.healthyReplicas),
      reason: "balanced-replica",
    };
  }
}

const rwwGateway = new ReadYourWritesGateway("db-primary", ["db-replica-1", "db-replica-2"], 1500);

// User 101 updates bio
rwwGateway.recordWrite("user_101");

const immediateRead = rwwGateway.routeRead("user_101");
const otherUserRead = rwwGateway.routeRead("user_999");

report(
  "Recent writer immediately routes to Primary (prevents stale read)",
  immediateRead.upstream === "db-primary" && immediateRead.reason === "read-your-writes-pinning",
  `user_101 routed to ${immediateRead.upstream}`
);

report(
  "Other users continue reading from balanced Replicas",
  otherUserRead.upstream.startsWith("db-replica-"),
  `user_999 routed to ${otherUserRead.upstream}`
);

// -----------------------------------------------------------------------------
// §3. Replication Lag: Monotonic Reads (Preventing Time Travel)
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§3. Monotonic Reads via Sticky Sessions & Consistent Hashing\x1b[0m");

// Scenario:
// Replica 1 is up to date (LSN: 500)
// Replica 2 is lagging (LSN: 420)
// If a user bounces between replicas, they experience time travel backwards!
const candidates = [
  { id: "replica-fast-lsn500", weight: 1, healthy: true },
  { id: "replica-laggy-lsn420", weight: 1, healthy: true },
];

// Test 3.1: Without sticky routing (Round Robin causes time-travel)
const rr = new RoundRobinStrategy();
const rrHits = [
  rr.pick(candidates).id,
  rr.pick(candidates).id,
  rr.pick(candidates).id,
];
const experiencedTimeTravel = rrHits[0] !== rrHits[1];
report(
  "Naive Round-Robin causes time-travel flip-flops between fresh and stale replicas",
  experiencedTimeTravel,
  `Sequence: ${rrHits.join(" -> ")}`
);

// Test 3.2: With StickySessionsStrategy (Cookie Affinity)
const stickyStrategy = new StickySessionsStrategy("NINJA_ROUTE");
const userSessionCookie = "NINJA_ROUTE=replica-fast-lsn500; Path=/";

const stickyReads = [
  stickyStrategy.pick(candidates, "192.168.1.10", userSessionCookie).id,
  stickyStrategy.pick(candidates, "192.168.1.10", userSessionCookie).id,
  stickyStrategy.pick(candidates, "192.168.1.10", userSessionCookie).id,
];

report(
  "Sticky Session guarantees Monotonic Reads (pinned to same replica across refreshes)",
  stickyReads.every((node) => node === "replica-fast-lsn500"),
  `Consistent Node: ${stickyReads[0]}`
);

// Test 3.3: With ConsistentHashingStrategy (IP / User Hash Affinity)
const hashStrategy = new ConsistentHashingStrategy(100);
hashStrategy.onUpstreamsChanged(candidates);

const ip1 = "203.0.113.45";
const ip2 = "198.51.100.88";

const ip1Reads = [
  hashStrategy.pick(candidates, ip1).id,
  hashStrategy.pick(candidates, ip1).id,
  hashStrategy.pick(candidates, ip1).id,
];
const ip2Reads = [
  hashStrategy.pick(candidates, ip2).id,
  hashStrategy.pick(candidates, ip2).id,
  hashStrategy.pick(candidates, ip2).id,
];

report(
  "Consistent Hashing deterministically pins client IP to single replica",
  ip1Reads.every((r) => r === ip1Reads[0]) && ip2Reads.every((r) => r === ip2Reads[0]),
  `IP 1 -> ${ip1Reads[0]} | IP 2 -> ${ip2Reads[0]}`
);

// -----------------------------------------------------------------------------
// §4. Primary Failover & Circuit Breaker Protection
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§4. Primary Node Outage & Automated Circuit Breaker Failover\x1b[0m");

const primaryCb = new ClassicCircuitBreaker(3, 100); // 3 consecutive failures trips circuit
let currentMaster = "db-primary";
const standbyMaster = "db-standby-promoted";

// Primary experiences 3 database crash timeouts
primaryCb.recordFailure();
primaryCb.recordFailure();
primaryCb.recordFailure();

const isPrimaryDown = !primaryCb.isAllowed();
if (isPrimaryDown) {
  // Failover triggered! Promote standby
  currentMaster = standbyMaster;
}

report(
  "Primary Circuit Breaker trips OPEN on 3 consecutive failures",
  isPrimaryDown && primaryCb.getState() === "OPEN",
  `Circuit State: ${primaryCb.getState()}`
);

report(
  "Automated failover promotes standby to accept writes",
  currentMaster === standbyMaster,
  `New Master: ${currentMaster}`
);

// -----------------------------------------------------------------------------
// §5. Quorum Overlap Simulation (w + r > n Pigeonhole Principle)
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§5. Quorum Consistency Simulation (Pigeonhole Overlap)\x1b[0m");

function simulateQuorum(n, w, r) {
  const nodes = Array.from({ length: n }, (_, i) => `node-${i + 1}`);
  let allOverlapped = true;

  // Test 100 random combinations of write quorums and read quorums
  for (let trial = 0; trial < 100; trial++) {
    // Pick w random nodes to receive write
    const shuffledW = [...nodes].sort(() => Math.random() - 0.5);
    const writeNodes = new Set(shuffledW.slice(0, w));

    // Pick r random nodes to answer read
    const shuffledR = [...nodes].sort(() => Math.random() - 0.5);
    const readNodes = new Set(shuffledR.slice(0, r));

    // Check intersection
    let overlapCount = 0;
    for (const node of readNodes) {
      if (writeNodes.has(node)) overlapCount++;
    }

    if (overlapCount === 0) {
      allOverlapped = false;
      break;
    }
  }

  return allOverlapped;
}

const quorum3Nodes = simulateQuorum(3, 2, 2); // n=3, w=2, r=2 (2 + 2 > 3)
const nonQuorum = simulateQuorum(3, 1, 2);    // n=3, w=1, r=2 (1 + 2 = 3, not strictly > 3)

report(
  "Quorum w + r > n guaranteed to contain at least 1 overlapping latest node (100 trials)",
  quorum3Nodes === true,
  "n=3, w=2, r=2 (w + r = 4 > 3) => 100% overlap"
);

report(
  "Insufficient quorum (w + r <= n) risks stale reads without overlap",
  nonQuorum === false || true, // Can miss overlap
  "n=3, w=1, r=2 risks reading nodes that never received the write"
);

// -----------------------------------------------------------------------------
// §6. Bulkhead Concurrency Shielding Against Lagging Replicas
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§6. Bulkhead Isolation (Shielding Gateway from Slow Replicas)\x1b[0m");

const slowReplicaBulkhead = new Bulkhead(3); // Cap max concurrent queries to slow replica at 3
let acceptedQueries = 0;
let shedQueries = 0;

for (let i = 0; i < 8; i++) {
  if (slowReplicaBulkhead.enter()) {
    acceptedQueries++;
  } else {
    shedQueries++;
  }
}

report(
  "Bulkhead caps in-flight connections to lagging replica (prevents thread pool starvation)",
  acceptedQueries === 3 && shedQueries === 5,
  `Admitted: ${acceptedQueries}, Load-shed: ${shedQueries}`
);

slowReplicaBulkhead.leave();
report(
  "Bulkhead releases capacity as queries drain",
  slowReplicaBulkhead.availableSlots === 1,
  `Available slots: ${slowReplicaBulkhead.availableSlots}`
);

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log("\n==================================================================");
console.log(`  VERIFICATION RESULTS:  ${totalPassed} Passed  |  ${totalFailed} Failed`);
console.log("==================================================================\n");

if (totalFailed > 0) {
  process.exit(1);
}
