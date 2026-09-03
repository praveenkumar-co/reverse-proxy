import { test } from "node:test";
import assert from "node:assert";
import { TokenBucketAlgorithm } from "../../../src/ratelimit/algorithms/token-bucket.js";
import { LeakingBucketAlgorithm } from "../../../src/ratelimit/algorithms/leaking-bucket.js";
import { FixedWindowAlgorithm } from "../../../src/ratelimit/algorithms/fixed-window.js";
import { SlidingWindowLogAlgorithm } from "../../../src/ratelimit/algorithms/sliding-window-log.js";
import { SlidingWindowCounterAlgorithm } from "../../../src/ratelimit/algorithms/sliding-window-counter.js";
import { RateLimiter } from "../../../src/ratelimit/rate-limiter.js";
import { SoftLimitPolicy } from "../../../src/ratelimit/policies/soft-limit.policy.js";
import { MultiDimensionPolicy } from "../../../src/ratelimit/policies/multi-dimension.policy.js";

test("RateLimit Algo 1: Token Bucket Capacity & Exhaustion", () => {
  const algo = new TokenBucketAlgorithm();
  assert.strictEqual(algo.check("key1", 2, 1000), true);
  assert.strictEqual(algo.check("key1", 2, 1000), true);
  assert.strictEqual(algo.check("key1", 2, 1000), false); // Empty
});

test("RateLimit Algo 2: Leaking Bucket Steady Leak", () => {
  const algo = new LeakingBucketAlgorithm();
  assert.strictEqual(algo.check("key2", 1, 1000), true);
  assert.strictEqual(algo.check("key2", 1, 1000), false); // Full
});

test("RateLimit Algo 3: Fixed Window Reset", async () => {
  const algo = new FixedWindowAlgorithm();
  assert.strictEqual(algo.check("key3", 1, 50), true);
  assert.strictEqual(algo.check("key3", 1, 50), false);
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(algo.check("key3", 1, 50), true); // Reset
});

test("RateLimit Algo 4: Sliding Window Log Filtering", () => {
  const algo = new SlidingWindowLogAlgorithm();
  assert.strictEqual(algo.check("key4", 2, 1000), true);
  assert.strictEqual(algo.check("key4", 2, 1000), true);
  assert.strictEqual(algo.check("key4", 2, 1000), false);
});

test("RateLimit Algo 5: Sliding Window Counter Interpolation", () => {
  const algo = new SlidingWindowCounterAlgorithm();
  assert.strictEqual(algo.check("key5", 2, 1000), true);
  assert.strictEqual(algo.check("key5", 2, 1000), true);
});

test("RateLimit Policy: Soft Limit Warning & Burst Allowance", () => {
  const policy = new SoftLimitPolicy(100, 80, 1.5);
  // Current load 50 < 80 soft limit -> burst allowed (150)
  assert.strictEqual(policy.effectiveLimit(50), 150);
  // Current load 90 >= 80 soft limit -> normal limit (100)
  assert.strictEqual(policy.effectiveLimit(90), 100);
});

test("RateLimit Policy: Multi-Dimension Key Builder (IP, Route, API-Key)", () => {
  const policy = new MultiDimensionPolicy([
    { dimension: "ip", maxRequests: 100, windowMs: 60000 },
    { dimension: "api-key", maxRequests: 500, windowMs: 60000 },
    { dimension: "route", maxRequests: 50, windowMs: 60000 },
  ]);

  const ipKey = policy.buildKey("ip", "10.0.0.1", "/api/v1");
  const apiKey = policy.buildKey("api-key", "key_secret_123", "/api/v1");

  assert.strictEqual(ipKey, "rl:ip:/api/v1:10.0.0.1");
  assert.strictEqual(apiKey, "rl:api-key:/api/v1:key_secret_123");
  assert.strictEqual(policy.getDimensions().length, 3);
});

test("RateLimiter Facade: Memory Storage Integration", async () => {
  const rl = new RateLimiter({
    windowMs: 60000,
    maxRequests: 2,
    algorithm: "fixed-window",
    storage: "memory",
  });

  assert.strictEqual(await rl.isAllowed("192.168.1.1"), true);
  assert.strictEqual(await rl.isAllowed("192.168.1.1"), true);
  assert.strictEqual(await rl.isAllowed("192.168.1.1"), false);
});
