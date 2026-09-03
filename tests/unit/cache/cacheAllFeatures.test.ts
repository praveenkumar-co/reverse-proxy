import { test } from "node:test";
import assert from "node:assert";
import { InMemoryLRU } from "../../../src/cache/stores/in-memory-lru.js";
import { HybridCache } from "../../../src/cache/stores/hybrid.cache.js";
import { KeyBuilder } from "../../../src/cache/policies/key-builder.js";
import { parseCacheControl } from "../../../src/cache/policies/cache-control.parser.js";
import { StaleIfError } from "../../../src/cache/policies/stale-if-error.js";
import { PatternInvalidator } from "../../../src/cache/invalidation/pattern.invalidator.js";
import { TagInvalidator } from "../../../src/cache/invalidation/tag.invalidator.js";
import { DebeziumInvalidator } from "../../../src/cache/invalidation/debezium.invalidator.js";

test("Cache 1: L1 In-Memory LRU Eviction & TTL", async () => {
  const lru = new InMemoryLRU(2);
  lru.set("k1", "v1", 0.05);
  lru.set("k2", "v2", 0.05);
  lru.set("k3", "v3", 0.05);

  assert.strictEqual(lru.get("k1"), null); // Evicted by LRU capacity 2
  assert.strictEqual(lru.get("k3"), "v3");

  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(lru.get("k3"), null); // Evicted by TTL
});

test("Cache 2: Hybrid Cache (L1 Memory + L2 Store Sync)", async () => {
  const mockL2 = {
    data: new Map<string, string>(),
    async get(key: string) { return this.data.get(key) ?? null; },
    async set(key: string, val: string) { this.data.set(key, val); },
    async del(key: string) { this.data.delete(key); },
    async invalidate() {},
    buildKey(m: string, p: string) { return `${m}:${p}`; }
  };

  await mockL2.set("redis-key", "redis-val");
  const hybrid = new HybridCache(mockL2, 10, 60);

  const val = await hybrid.get("redis-key"); // Fetches from L2 & warms L1
  assert.strictEqual(val, "redis-val");
});

test("Cache 3: Stale-If-Error Policy", () => {
  const stalePolicy = new StaleIfError();
  assert.strictEqual(stalePolicy.shouldServeStale(503, 60, 30), true);
  assert.strictEqual(stalePolicy.shouldServeStale(200, 60, 30), false);
});

test("Cache 4: KeyBuilder Query Param Stripping & Header Vary", () => {
  const builder = new KeyBuilder({ ignoreQueryParams: ["utm_source"], varyHeaders: ["Accept-Encoding"] });
  const k1 = builder.build("GET", "http://dummy/api/items?utm_source=fb&id=10", { "accept-encoding": "gzip" });
  const k2 = builder.build("GET", "http://dummy/api/items?id=10", { "accept-encoding": "gzip" });
  assert.strictEqual(k1, k2);
});

test("Cache 5: CacheControl Parser Directives", () => {
  const parsed = parseCacheControl("public, max-age=300, s-maxage=600, no-cache");
  assert.strictEqual(parsed.maxAge, 300);
  assert.strictEqual(parsed.sMaxAge, 600);
  assert.strictEqual(parsed.noCache, true);
});

test("Cache 6: Pattern & Tag Invalidators", async () => {
  let invalidatedPattern = "";
  const patternInv = new PatternInvalidator({ invalidate: async (p) => { invalidatedPattern = p; } });
  await patternInv.invalidate("/api/products/*");
  assert.strictEqual(invalidatedPattern, "/api/products/*");

  const tagInv = new TagInvalidator();
  tagInv.tag("item:10", ["catalog"]);
  assert.deepStrictEqual(tagInv.getKeysForTag("catalog"), ["item:10"]);
});

test("Cache 7: Debezium CDC Invalidator (SQL + Mongo ObjectId)", async () => {
  let invalidatedPath = "";
  const debezium = new DebeziumInvalidator(
    [{ table: "users", pathPattern: "/api/users/{id}" }],
    async (p) => { invalidatedPath = p; }
  );

  // SQL
  await debezium.handle(JSON.stringify({ op: "u", source: { table: "users" }, after: { id: "55" } }));
  assert.strictEqual(invalidatedPath, "/api/users/55");

  // MongoDB ObjectId
  await debezium.handle(JSON.stringify({
    op: "u",
    source: { collection: "users" },
    after: { _id: { $oid: "60d5ec4b1234567890abcdef" } }
  }));
  assert.strictEqual(invalidatedPath, "/api/users/60d5ec4b1234567890abcdef");
});
