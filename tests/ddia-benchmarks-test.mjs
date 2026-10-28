// =============================================================================
// REVERSE PROXY — DISTRIBUTED RESILIENCE & LOAD BALANCER BENCHMARKS
// =============================================================================
// Verifies core distributed systems traffic management capabilities:
//   1. Head-of-Line Blocking Mitigation (Round-Robin vs. Least-Connections)
//   2. Tail Latency & Percentiles (p50, p90, p95, p99, p99.9 via Prometheus Histograms)
//   3. Bulkhead Concurrency Isolation (Preventing Queue Saturation)
//   4. Adaptive Circuit Breaker (Client-Side Throttling)
//   5. Thundering Herd Prevention (Full Jitter Backoff vs. Plain Exponential)
// =============================================================================

import { LoadBalancer } from "../dist/balancer/core/load-balancer.js";
import { RoundRobinStrategy } from "../dist/balancer/strategies/round-robin.strategy.js";
import { LeastConnectionsStrategy } from "../dist/balancer/strategies/least-connections.strategy.js";
import { PowerOfTwoStrategy } from "../dist/balancer/strategies/power-of-two.strategy.js";
import { Bulkhead } from "../dist/resilience/bulkhead/bulkhead.js";
import { AdaptiveCircuitBreaker } from "../dist/resilience/circuit-breaker/adaptive.circuit-breaker.js";
import { ClassicCircuitBreaker } from "../dist/resilience/circuit-breaker/classic.circuit-breaker.js";
import { calculateFullJitterBackoff } from "../dist/resilience/retry/backoff/full-jitter.backoff.js";
import { calculateExponentialBackoff } from "../dist/resilience/retry/backoff/exponential.backoff.js";
import { HistogramRegistry } from "../dist/observability/metrics/histogram.registry.js";

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

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(index, sortedArr.length - 1))];
}

console.log("\n==================================================================");
console.log("   DISTRIBUTED RESILIENCE & TRAFFIC MANAGEMENT BENCHMARKS         ");
console.log("==================================================================\n");

// -----------------------------------------------------------------------------
// §1. Head-of-Line Blocking: Round-Robin vs. Least-Connections Simulation
// -----------------------------------------------------------------------------
console.log("\x1b[1m§1. Head-of-Line Blocking Demonstration\x1b[0m");
console.log("   Simulating 2 backends: Server-Fast (5ms) vs. Server-Slow (100ms slow DB query)");

function simulateTraffic(strategyInstance, numRequests = 60) {
  const lb = new LoadBalancer(
    {
      strategy: "test",
      upstreams: [
        { id: "srv-fast", weight: 1 },
        { id: "srv-slow", weight: 1 },
      ],
    },
    strategyInstance
  );

  const healthySet = new Set(["srv-fast", "srv-slow"]);
  const latencies = [];
  const serverCounts = { "srv-fast": 0, "srv-slow": 0 };

  // To simulate concurrency:
  // Each request to srv-slow stays in flight for 100ms.
  // Each request to srv-fast completes in 5ms.
  // Requests arrive at constant rate (every 2ms - Open Model Arrival)
  const inFlightTimeouts = [];

  for (let i = 0; i < numRequests; i++) {
    const chosenId = lb.pickFiltered(healthySet);
    if (!chosenId) continue;
    serverCounts[chosenId]++;
    lb.incrementConnection(chosenId);

    const isSlow = chosenId === "srv-slow";
    const latency = isSlow ? 100 : 5;
    latencies.push(latency);

    // Simulate completion
    inFlightTimeouts.push({
      id: chosenId,
      completeAt: i * 2 + latency,
    });

    // Cleanup any connections that have finished by current time (i * 2)
    const now = i * 2;
    for (let j = inFlightTimeouts.length - 1; j >= 0; j--) {
      if (inFlightTimeouts[j].completeAt <= now) {
        lb.releaseConnection(inFlightTimeouts[j].id);
        inFlightTimeouts.splice(j, 1);
      }
    }
  }

  // Cleanup rest
  for (const item of inFlightTimeouts) {
    lb.releaseConnection(item.id);
  }

  latencies.sort((a, b) => a - b);
  return {
    latencies,
    serverCounts,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
  };
}

const rrResult = simulateTraffic(new RoundRobinStrategy());
const lcResult = simulateTraffic(new LeastConnectionsStrategy());

console.log(`   [Round-Robin]        Dispatched: Fast=${rrResult.serverCounts["srv-fast"]}, Slow=${rrResult.serverCounts["srv-slow"]}`);
console.log(`                        Latency: Avg=${rrResult.avg.toFixed(1)}ms | p50=${rrResult.p50}ms | p95=${rrResult.p95}ms | p99=${rrResult.p99}ms`);
console.log(`   [Least-Connections]  Dispatched: Fast=${lcResult.serverCounts["srv-fast"]}, Slow=${lcResult.serverCounts["srv-slow"]}`);
console.log(`                        Latency: Avg=${lcResult.avg.toFixed(1)}ms | p50=${lcResult.p50}ms | p95=${lcResult.p95}ms | p99=${lcResult.p99}ms`);

report(
  "Head-of-Line Blocking is avoided by Least-Connections",
  lcResult.serverCounts["srv-fast"] > rrResult.serverCounts["srv-fast"] && lcResult.p50 <= rrResult.p50,
  `Least-Connections routed ${lcResult.serverCounts["srv-fast"]}/${60} requests to Fast server`
);

// -----------------------------------------------------------------------------
// §2. Tail Latency & Percentiles (Prometheus Histogram Tracking)
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§2. Tail Latency & Prometheus Histogram Buckets (p50, p95, p99)\x1b[0m");

const histReg = new HistogramRegistry();
const durationHist = histReg.getOrCreate("ninja_http_request_duration_ms");

// Generate realistic multimodal distribution (most fast, few tail outliers):
// 90 fast requests (3ms - 15ms)
// 7 medium requests (40ms - 80ms)
// 3 tail outliers (450ms, 1200ms, 2500ms)
const sampleLatencies = [];
for (let i = 0; i < 90; i++) sampleLatencies.push(4 + (i % 10));
for (let i = 0; i < 7; i++) sampleLatencies.push(45 + i * 5);
sampleLatencies.push(450, 1200, 2500);

for (const lat of sampleLatencies) {
  durationHist.observe(lat);
}

sampleLatencies.sort((a, b) => a - b);
const p50 = percentile(sampleLatencies, 50);
const p95 = percentile(sampleLatencies, 95);
const p99 = percentile(sampleLatencies, 99);
const mean = sampleLatencies.reduce((a, b) => a + b, 0) / sampleLatencies.length;

console.log(`   Sample Set (100 requests): Arithmetic Mean = ${mean.toFixed(1)}ms`);
console.log(`   Percentiles: p50 = ${p50}ms | p90 = ${percentile(sampleLatencies, 90)}ms | p95 = ${p95}ms | p99 = ${p99}ms | Max = ${sampleLatencies[sampleLatencies.length - 1]}ms`);

const promText = durationHist.toPrometheus("ninja_http_request_duration_ms", 'method="GET",path="/api"');
const hasBuckets = promText.includes('le="25"') && promText.includes('le="1000"') && promText.includes('le="+Inf"');

report(
  "Prometheus Histogram captures tail latency buckets correctly",
  hasBuckets && p99 > p50 * 50,
  `Mean (${mean.toFixed(1)}ms) disguised extreme p99 tail (${p99}ms)`
);

// -----------------------------------------------------------------------------
// §3. Bulkhead Pattern: Concurrency Isolation & Queue Caps
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§3. Bulkhead Concurrency Guard (Preventing Saturation)\x1b[0m");

const bulkhead = new Bulkhead(5); // Maximum 5 concurrent slots
let admitted = 0;
let rejected = 0;

for (let i = 0; i < 12; i++) {
  if (bulkhead.enter()) {
    admitted++;
  } else {
    rejected++;
  }
}

console.log(`   Bulkhead limit: 5 slots. Tested with 12 simultaneous requests: Admitted=${admitted}, Rejected=${rejected}`);
report(
  "Bulkhead sheds excess concurrency load (isAtCapacity / enter)",
  admitted === 5 && rejected === 7 && bulkhead.availableSlots === 0,
  `Admitted exactly 5, gracefully rejected ${rejected}`
);

bulkhead.leave();
bulkhead.leave();
report(
  "Bulkhead restores available slots as requests complete",
  bulkhead.availableSlots === 2 && bulkhead.getActiveCount() === 3,
  `Available slots restored to ${bulkhead.availableSlots}`
);

// -----------------------------------------------------------------------------
// §4. Google SRE Adaptive Circuit Breaker (Client-Side Throttling)
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§4. Google SRE Adaptive Circuit Breaker Throttling\x1b[0m");

const adaptiveCb = new AdaptiveCircuitBreaker(2.0, 0.9); // K = 2, decay = 0.9

// Initially 10 successes
for (let i = 0; i < 10; i++) adaptiveCb.recordSuccess(10);
let initialStats = adaptiveCb.getStats();
console.log(`   Healthy State: Requests=${initialStats.requests.toFixed(1)}, Accepts=${initialStats.accepts.toFixed(1)}, DropProbability=${initialStats.dropProbability.toFixed(3)}`);

report(
  "Adaptive Circuit Breaker allows 100% traffic during healthy state",
  initialStats.dropProbability === 0,
  "dropProbability = 0.00"
);

// Induce 25 backend errors
for (let i = 0; i < 25; i++) adaptiveCb.recordFailure();
let degradedStats = adaptiveCb.getStats();
console.log(`   Degraded State: Requests=${degradedStats.requests.toFixed(1)}, Accepts=${degradedStats.accepts.toFixed(1)}, DropProbability=${degradedStats.dropProbability.toFixed(3)}`);

report(
  "Adaptive Circuit Breaker calculates SRE drop probability under failure",
  degradedStats.dropProbability > 0.5,
  `dropProbability escalated to ${(degradedStats.dropProbability * 100).toFixed(1)}%`
);

// -----------------------------------------------------------------------------
// §5. Classic Circuit Breaker State Transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§5. Classic Circuit Breaker Lifecycle (State Machine)\x1b[0m");

const classicCb = new ClassicCircuitBreaker(3, 50); // Threshold 3, recovery 50ms
report("Initial State is CLOSED", classicCb.getState() === "CLOSED" && classicCb.isAllowed() === true);

classicCb.recordFailure();
classicCb.recordFailure();
classicCb.recordFailure();
report("Trips to OPEN after 3 consecutive failures", classicCb.getState() === "OPEN" && classicCb.isAllowed() === false);

// Wait for recoveryTimeMs (50ms)
await new Promise(r => setTimeout(r, 60));
const allowedProbe = classicCb.isAllowed(); // Checks recovery -> transitions to HALF_OPEN
report("Transitions to HALF_OPEN after recovery window", classicCb.getState() === "HALF_OPEN" && allowedProbe === true);

classicCb.recordSuccess(12);
report("Recovers back to CLOSED on successful probe", classicCb.getState() === "CLOSED" && classicCb.getFailures() === 0);

// -----------------------------------------------------------------------------
// §6. Thundering Herd Prevention: Full Jitter vs. Plain Exponential Backoff
// -----------------------------------------------------------------------------
console.log("\n\x1b[1m§6. Thundering Herd Prevention (Full Jitter vs. Exponential)\x1b[0m");

const expDelays = [];
const jitterDelays = [];

for (let i = 0; i < 10; i++) {
  expDelays.push(calculateExponentialBackoff(2, 100, 5000));
  jitterDelays.push(Math.round(calculateFullJitterBackoff(2, 100, 5000)));
}

console.log(`   Plain Exponential (Attempt 2): All clients retry at exact same millisecond: [${expDelays.slice(0, 5).join(", ")}ms] (Thundering Herd Risk!)`);
console.log(`   Full Jitter       (Attempt 2): Dispersed uniformly across [0, 400ms]:        [${jitterDelays.slice(0, 5).join(", ")}ms]`);

const isJitterDistributed = new Set(jitterDelays).size > 1;
report(
  "Full Jitter successfully randomizes sleep interval across clients",
  isJitterDistributed && jitterDelays.every(d => d >= 0 && d <= 400),
  `Delays dispersed smoothly between 0ms and 400ms`
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
