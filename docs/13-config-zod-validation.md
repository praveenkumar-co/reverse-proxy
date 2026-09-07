# ⚙️ Config & Zod Validation — How It Works

## What Is Zod?

Zod is a TypeScript-first schema validation library. It lets you define the exact shape of your config and validates it at runtime — catching bad config before the proxy starts, not after it crashes.

---

## Why Config Validation Matters

Without validation:
```yaml
loadBalancing:
  strategy: roud-robin  # typo — proxy starts, crashes mysteriously later
```

With Zod:
```
ZodError: Invalid enum value at loadBalancing.strategy.
Expected: 'round-robin' | 'least-connections' | 'power-of-two' | ...
Received: 'roud-robin'
```
Fails immediately at startup with a clear error.

---

## Config Loading Flow

```typescript
// config/loader.ts
1. Read proxy.yaml from --config flag path
2. Parse YAML → raw JS object
3. Run Zod schema validation
4. If validation fails → throw with exact field + message
5. If passes → return typed ProxyConfig object
6. Master stores it in ACTIVE_CONFIG
7. Master serializes it to JSON → sends to workers via APP_CONFIG env var
```

---

## Zod Schema Example

```typescript
// config/schema.ts
const LoadBalancingSchema = z.object({
    strategy: z.enum([
        'round-robin',
        'weighted-round-robin',
        'least-connections',
        'power-of-two',
        'consistent-hashing',
        'ip-hash',
        'sticky',
        'adaptive-wrr',
        'resource-based',
        'random',
    ]),
    virtualNodes: z.number().min(1).max(1000).default(150),
    ewmaAlpha: z.number().min(0).max(1).default(0.1),
    stickyCookieName: z.string().default('NINJA_ROUTE'),
});

const TlsSchema = z.object({
    enabled: z.boolean().default(false),
    cert: z.string().optional(),
    key: z.string().optional(),
    redirectHttp: z.boolean().default(true),
    httpsPort: z.number().default(8443),
});

const ProxyConfigSchema = z.object({
    server: ServerSchema,
    upstreams: z.array(UpstreamSchema).min(1),
    tls: TlsSchema.optional(),
    loadBalancing: LoadBalancingSchema,
    rateLimit: RateLimitSchema,
    cache: CacheSchema,
    resilience: ResilienceSchema,
    observability: ObservabilitySchema.optional(),
});
```

---

## Runtime Type Safety

```typescript
// After validation, config is fully typed
const config: ProxyConfig = ProxyConfigSchema.parse(rawYaml);

// TypeScript knows exactly what's in here
config.loadBalancing.strategy;  // type: "round-robin" | "least-connections" | ...
config.tls?.httpsPort;          // type: number | undefined
config.upstreams[0].url;        // type: string
```

No `any` types, no runtime surprises — TypeScript catches bad access at compile time.

---