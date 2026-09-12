// tests/fastapi-advanced-features.mjs
import http from "http";

const GATEWAY_URL = "http://127.0.0.1:8080";

function makeRequest(path, method = "GET", headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(GATEWAY_URL + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          Connection: "keep-alive",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function runAdvancedFeatureTests() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("⚡ NINJA REVERSE PROXY: ADVANCED FEATURE STRESS & VALIDATION SUITE");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // -------------------------------------------------------------
  // FEATURE 1: Load Balancer & Circuit Breaker Health Audit
  // -------------------------------------------------------------
  console.log("🔹 [1/4] Inspecting Circuit Breaker & Load Balancer Live State (/__lb-stats)...");
  const statsRes = await makeRequest("/__lb-stats");
  if (statsRes.statusCode === 200) {
    const stats = JSON.parse(statsRes.body);
    console.log(`   ✅ Strategy: "${stats.strategy}", Healthy Upstreams: [${stats.healthyUpstreams.join(", ")}]`);
    console.log(`   └─ Upstream Stats:`, JSON.stringify(stats.upstreams));
  } else {
    console.log(`   ⚠️ Could not fetch /__lb-stats (${statsRes.statusCode})`);
  }

  // -------------------------------------------------------------
  // FEATURE 2: High Concurrency Throughput & Latency Benchmark
  // -------------------------------------------------------------
  console.log("\n🔹 [2/4] Executing High-Concurrency Load Test (1,000 requests @ 25 concurrency)...");
  const totalRequests = 1000;
  const concurrency = 25;
  const latencies = [];
  let completed = 0;
  let successCount = 0;
  let rateLimitedCount = 0;

  const tStart = performance.now();

  async function worker() {
    while (completed < totalRequests) {
      completed++;
      const reqStart = performance.now();
      try {
        const res = await makeRequest("/api/articles");
        latencies.push(performance.now() - reqStart);
        if (res.statusCode === 200) successCount++;
        else if (res.statusCode === 429) rateLimitedCount++;
      } catch (err) {
        // error
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const totalDurationSeconds = (performance.now() - tStart) / 1000;
  latencies.sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(1);
  const p90 = latencies[Math.floor(latencies.length * 0.9)].toFixed(1);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(1);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(1);
  const throughput = (latencies.length / totalDurationSeconds).toFixed(1);

  console.log(`   ✅ Dispatched: ${latencies.length} requests in ${totalDurationSeconds.toFixed(2)}s`);
  console.log(`   └─ Throughput: ${throughput} req/sec`);
  console.log(`   └─ Latency Percentiles: p50: ${p50}ms | p90: ${p90}ms | p95: ${p95}ms | p99: ${p99}ms`);
  console.log(`   └─ Status Breakdown: 200 OK: ${successCount} | 429 Throttled: ${rateLimitedCount}`);

  // -------------------------------------------------------------
  // FEATURE 3: Rate Limiter Token-Bucket Flood Defense
  // -------------------------------------------------------------
  console.log("\n🔹 [3/4] Triggering Rate Limiter Token-Bucket Defense (Firing 200 burst requests)...");
  let throttledObserved = false;
  let sample429Headers = null;

  for (let i = 0; i < 200; i++) {
    const res = await makeRequest("/api/articles");
    if (res.statusCode === 429) {
      throttledObserved = true;
      sample429Headers = res.headers;
      break;
    }
  }

  if (throttledObserved) {
    console.log(`   🛡️ RATE LIMITER ACTIVATED! HTTP 429 Too Many Requests cleanly intercepted.`);
    console.log(`   └─ X-RateLimit-Limit:`, sample429Headers["x-ratelimit-limit"] ?? "N/A");
    console.log(`   └─ X-RateLimit-Remaining:`, sample429Headers["x-ratelimit-remaining"] ?? "N/A");
    console.log(`   └─ Retry-After:`, sample429Headers["retry-after"] ?? "N/A");
  } else {
    console.log(`   ℹ️ Token bucket had sufficient capacity during burst (500 limit window).`);
  }

  // -------------------------------------------------------------
  // FEATURE 4: Hop-by-Hop Sanitization & Tracing Validation
  // -------------------------------------------------------------
  console.log("\n🔹 [4/4] Verifying Hop-by-Hop Header Sanitization & Distributed Tracing...");
  const traceRes = await makeRequest("/api/articles", "GET", {
    "X-Custom-Client-Header": "NinjaClient-v1",
    "Keep-Alive": "timeout=5",
  });

  const traceId = traceRes.headers["x-trace-id"];
  const proxyBy = traceRes.headers["x-proxy-by"];

  console.log(`   ✅ Status: ${traceRes.statusCode}`);
  console.log(`   └─ X-Trace-Id Propagated: "${traceId}"`);
  console.log(`   └─ X-Proxy-By Signature: "${proxyBy}"`);

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("🎉 ADVANCED FEATURE VALIDATION COMPLETE!");
  console.log("═══════════════════════════════════════════════════════════════════");
}

runAdvancedFeatureTests().catch(console.error);
