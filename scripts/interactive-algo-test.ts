import { TokenBucketAlgorithm } from "../src/ratelimit/algorithms/token-bucket.js";
import { FixedWindowAlgorithm } from "../src/ratelimit/algorithms/fixed-window.js";
import { ClassicCircuitBreaker } from "../src/resilience/circuit-breaker/classic.circuit-breaker.js";
import { createLoadBalancer } from "../src/balancer/index.js";

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function runInteractivePlayground() {
  console.log("\n=========================================================");
  console.log("🎮 INTERACTIVE ALGORITHM & TIMING PLAYGROUND");
  console.log("=========================================================\n");

  // --- DEMO 1: Token Bucket ---
  console.log("--- 1. TOKEN BUCKET (Cap: 2 tokens, Window: 1000ms) ---");
  const tb = new TokenBucketAlgorithm();
  console.log("Req 1 (0ms):", tb.check("user-ip", 2, 1000) ? "✅ ALLOWED" : "❌ BLOCKED");
  console.log("Req 2 (0ms):", tb.check("user-ip", 2, 1000) ? "✅ ALLOWED" : "❌ BLOCKED");
  console.log("Req 3 (0ms):", tb.check("user-ip", 2, 1000) ? "✅ ALLOWED" : "❌ BLOCKED (Bucket empty!)");
  
  console.log("\n⏳ Waiting 1100ms for bucket to refill tokens...");
  await sleep(1100);
  console.log("Req 4 (1100ms):", tb.check("user-ip", 2, 1000) ? "✅ ALLOWED (Refilled!)" : "❌ BLOCKED");

  // --- DEMO 2: Fixed Window Reset ---
  console.log("\n--- 2. FIXED WINDOW (Limit: 2 reqs, Window: 100ms) ---");
  const fw = new FixedWindowAlgorithm();
  console.log("Req 1 (0ms):", fw.check("fw-ip", 2, 100) ? "✅ ALLOWED" : "❌ BLOCKED");
  console.log("Req 2 (0ms):", fw.check("fw-ip", 2, 100) ? "✅ ALLOWED" : "❌ BLOCKED");
  console.log("Req 3 (0ms):", fw.check("fw-ip", 2, 100) ? "✅ ALLOWED" : "❌ BLOCKED (Window limit reached)");
  
  console.log("\n⏳ Waiting 110ms for 100ms window to expire...");
  await sleep(110);
  console.log("Req 4 (110ms):", fw.check("fw-ip", 2, 100) ? "✅ ALLOWED (New window!)" : "❌ BLOCKED");

  // --- DEMO 3: Circuit Breaker State Transitions ---
  console.log("\n--- 3. CIRCUIT BREAKER (Threshold: 2 failures, Recovery: 100ms) ---");
  const cb = new ClassicCircuitBreaker(2, 100);
  console.log("Initial State:", cb.getState());
  console.log("Recording Failure 1..."); cb.recordFailure();
  console.log("State:", cb.getState());
  console.log("Recording Failure 2..."); cb.recordFailure();
  console.log("State:", cb.getState(), "💥 TRIPPED TO OPEN!");

  console.log("Request during OPEN state:", cb.isAllowed() ? "✅ ALLOWED" : "❌ BLOCKED BY CIRCUIT BREAKER");

  console.log("\n⏳ Waiting 110ms for recovery timer...");
  await sleep(110);
  console.log("State after 110ms:", cb.getState(), "🔄 HALF_OPEN");
  console.log("Trial Request allowed in HALF_OPEN:", cb.isAllowed() ? "✅ ALLOWED (Trial)" : "❌ BLOCKED");
  console.log("Trial Request Succeeded! Resetting...");
  cb.recordSuccess(10);
  console.log("State after Success:", cb.getState(), "🟢 CLOSED (Fully Restored)");

  // --- DEMO 4: Weighted Round Robin Ratio ---
  console.log("\n--- 4. WEIGHTED ROUND ROBIN (Node-A: Weight 3, Node-B: Weight 1) ---");
  const lb = createLoadBalancer({
    strategy: "weighted-round-robin",
    upstreams: [{ id: "node-a", weight: 3 }, { id: "node-b", weight: 1 }]
  });
  const healthy = new Set(["node-a", "node-b"]);
  const counts: Record<string, number> = { "node-a": 0, "node-b": 0 };
  for (let i = 0; i < 20; i++) {
    const pick = lb.pickFiltered(healthy);
    if (pick) counts[pick] = (counts[pick] ?? 0) + 1;
  }
  console.log("20 Requests Pick Ratio:", counts);
  console.log(`Node-A: ${counts["node-a"] ?? 0} reqs (75%), Node-B: ${counts["node-b"] ?? 0} reqs (25%)`);

  console.log("\n=========================================================");
  console.log("✅ PLAYGROUND DEMO COMPLETE!");
  console.log("=========================================================\n");
}

runInteractivePlayground().catch(console.error);
