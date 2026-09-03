import { test } from "node:test";
import assert from "node:assert";
import { TokenBucketAlgorithm } from "../../../src/ratelimit/algorithms/token-bucket.js";
import { LeakingBucketAlgorithm } from "../../../src/ratelimit/algorithms/leaking-bucket.js";
import { FixedWindowAlgorithm } from "../../../src/ratelimit/algorithms/fixed-window.js";
import { SlidingWindowLogAlgorithm } from "../../../src/ratelimit/algorithms/sliding-window-log.js";
import { RateLimiter } from "../../../src/ratelimit/rate-limiter.js";
import { MultiDimensionPolicy } from "../../../src/ratelimit/policies/multi-dimension.policy.js";

test("TokenBucketAlgorithm - capacity and consumption", () => {
  const algo = new TokenBucketAlgorithm();
  let allowed = algo.check("key-1", 3, 1000);
  assert.strictEqual(allowed, true);

  allowed = algo.check("key-1", 3, 1000);
  assert.strictEqual(allowed, true);

  allowed = algo.check("key-1", 3, 1000);
  assert.strictEqual(allowed, true);

  allowed = algo.check("key-1", 3, 1000);
  assert.strictEqual(allowed, false);
});

test("LeakingBucketAlgorithm - capacity limits", () => {
  const algo = new LeakingBucketAlgorithm();
  let allowed = algo.check("key-leak", 2, 1000);
  assert.strictEqual(allowed, true);

  allowed = algo.check("key-leak", 2, 1000);
  assert.strictEqual(allowed, true);

  allowed = algo.check("key-leak", 2, 1000);
  assert.strictEqual(allowed, false);
});

test("FixedWindowAlgorithm - resets on new window", async () => {
  const algo = new FixedWindowAlgorithm();
  let allowed = algo.check("fw-1", 2, 50);
  assert.strictEqual(allowed, true);

  allowed = algo.check("fw-1", 2, 50);
  assert.strictEqual(allowed, true);

  allowed = algo.check("fw-1", 2, 50);
  assert.strictEqual(allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  allowed = algo.check("fw-1", 2, 50);
  assert.strictEqual(allowed, true);
});

test("SlidingWindowLogAlgorithm - log window filtering", () => {
  const algo = new SlidingWindowLogAlgorithm();
  let allowed = algo.check("swl-1", 2, 100);
  assert.strictEqual(allowed, true);

  allowed = algo.check("swl-1", 2, 100);
  assert.strictEqual(allowed, true);

  allowed = algo.check("swl-1", 2, 100);
  assert.strictEqual(allowed, false);
});

test("RateLimiter Facade - integrates memory storage", async () => {
  const rl = new RateLimiter({
    windowMs: 60000,
    maxRequests: 2,
    algorithm: "fixed-window",
    storage: "memory",
  });

  let allowed = await rl.isAllowed("user-1");
  assert.strictEqual(allowed, true);

  allowed = await rl.isAllowed("user-1");
  assert.strictEqual(allowed, true);

  allowed = await rl.isAllowed("user-1");
  assert.strictEqual(allowed, false);
});

test("MultiDimensionPolicy - builds key correctly", () => {
  const policy = new MultiDimensionPolicy([
    { dimension: "ip", maxRequests: 100, windowMs: 60000 },
    { dimension: "api-key", maxRequests: 500, windowMs: 60000 },
  ]);

  const key = policy.buildKey("ip", "192.168.1.1", "/api");
  assert.strictEqual(key, "rl:ip:/api:192.168.1.1");
  assert.strictEqual(policy.getDimensions().length, 2);
});
