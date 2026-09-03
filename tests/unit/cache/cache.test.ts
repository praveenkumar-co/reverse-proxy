import { test } from "node:test";
import assert from "node:assert";
import { InMemoryLRU } from "../../../src/cache/stores/in-memory-lru.js";
import { KeyBuilder } from "../../../src/cache/policies/key-builder.js";
import { parseCacheControl } from "../../../src/cache/policies/cache-control.parser.js";
import { PatternInvalidator } from "../../../src/cache/invalidation/pattern.invalidator.js";
import { TagInvalidator } from "../../../src/cache/invalidation/tag.invalidator.js";
import { DebeziumInvalidator } from "../../../src/cache/invalidation/debezium.invalidator.js";

test("InMemoryLRU - set, get, TTL expiration", async () => {
  const cache = new InMemoryLRU(100);
  cache.set("key1", "val1", 0.05);

  let val = cache.get("key1");
  assert.strictEqual(val, "val1");

  await new Promise((resolve) => setTimeout(resolve, 60));
  val = cache.get("key1");
  assert.strictEqual(val, null);
});

test("InMemoryLRU - max size eviction", () => {
  const cache = new InMemoryLRU(2);
  cache.set("k1", "v1", 60);
  cache.set("k2", "v2", 60);
  cache.set("k3", "v3", 60);

  const v1 = cache.get("k1");
  const v3 = cache.get("k3");
  assert.strictEqual(v1, null);
  assert.strictEqual(v3, "v3");
});

test("KeyBuilder - ignores specified query params", () => {
  const builder = new KeyBuilder({ ignoreQueryParams: ["utm_source"] });
  const key1 = builder.build("GET", "http://dummy/api/data?utm_source=google&page=1");
  const key2 = builder.build("GET", "http://dummy/api/data?page=1");
  assert.strictEqual(key1, key2);
});

test("CacheControlParser - parses directives correctly", () => {
  const parsed = parseCacheControl("private, max-age=3600, s-maxage=7200, no-cache");
  assert.strictEqual(parsed.private, true);
  assert.strictEqual(parsed.maxAge, 3600);
  assert.strictEqual(parsed.sMaxAge, 7200);
  assert.strictEqual(parsed.noCache, true);
});

test("PatternInvalidator - matches glob pattern", async () => {
  const invalidated: string[] = [];
  const invalidator = new PatternInvalidator({
    invalidate: async (pat) => { invalidated.push(pat); },
  });
  await invalidator.invalidate("/api/users/*");
  assert.strictEqual(invalidated[0], "/api/users/*");
});

test("TagInvalidator - tags and retrieves keys", () => {
  const tagManager = new TagInvalidator();
  tagManager.tag("key1", ["users"]);
  tagManager.tag("key2", ["users"]);

  const keys = tagManager.getKeysForTag("users");
  assert.strictEqual(keys.length, 2);
  assert.ok(keys.includes("key1"));
  assert.ok(keys.includes("key2"));
});

test("DebeziumInvalidator - parses CDC events for SQL/NoSQL", async () => {
  const invalidated: string[] = [];
  const debezium = new DebeziumInvalidator(
    [{ table: "users", pathPattern: "/api/users/{id}" }],
    async (path) => { invalidated.push(path); },
  );

  const eventJson = JSON.stringify({
    op: "u",
    source: { table: "users" },
    after: { id: "42" },
  });

  await debezium.handle(eventJson);
  assert.strictEqual(invalidated[0], "/api/users/42");
});
