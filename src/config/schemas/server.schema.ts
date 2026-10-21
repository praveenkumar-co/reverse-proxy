import { z } from "zod";
import { loadBalancerSchema } from "./balancer.schema.js";
import { cacheSchema } from "./cache.schema.js";
import { resilienceSchema } from "./resilience.schema.js";
import { rateLimitSchema } from "./ratelimit.schema.js";
import { discoverySchema } from "./discovery.schema.js";
import { adminSchema } from "./admin.schema.js";
import { observabilitySchema } from "./observability.schema.js";

const upstreamTlsSchema = z
  .object({
    rejectUnauthorized: z.boolean().default(true),
    ca: z.string().optional(),
  })
  .optional();

const upstreamSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  weight: z.number().default(1),
  healthPath: z.string().default("/health"),
  tls: upstreamTlsSchema,
  maxConnections: z.number().optional(),
});

const pathRateLimitSchema = z
  .object({
    windowMs: z.number(),
    maxRequests: z.number(),
    algorithm: z
      .enum([
        "fixed-window",
        "sliding-window-log",
        "sliding-window-counter",
        "token-bucket",
        "leaking-bucket",
      ])
      .default("fixed-window"),
    storage: z.enum(["memory", "redis", "hybrid"]).default("memory"),
  })
  .optional();

const pathCacheSchema = z
  .object({
    enabled: z.boolean().default(true),
    ttlSeconds: z.number().optional(),
  })
  .optional();

export const canarySchema = z
  .object({
    enabled: z.boolean().default(false),
    canaryUpstream: z.string(),
    baselineUpstream: z.string().optional(),
    weight: z.number().min(0).max(100).default(10),
    stickyCookieName: z.string().default("NINJA_CANARY"),
    headerKey: z.string().optional(),
    headerValue: z.string().optional(),
    stage: z.string().default("canary"),
    allowedIps: z.array(z.string()).optional(),
    stripHeader: z.boolean().default(true),
    maxConnections: z.number().positive().optional(),
  })
  .optional()
  .refine(
    (data) => {
      if (!data) return true;
      return !data.headerKey === !data.headerValue;
    },
    {
      message: "Both 'headerKey' and 'headerValue' must be provided together",
      path: ["headerKey"],
    },
  );

export type CanaryConfigType = z.infer<typeof canarySchema>;

const routeAuthSchema = z
  .object({
    tokens: z.array(z.string()),
  })
  .optional();

const routeSchema = z.object({
  path: z.string(),
  upstreams: z.array(z.string()),
  methods: z.array(z.string()).optional(),
  rateLimit: pathRateLimitSchema,
  sticky: z.boolean().default(false),
  cache: pathCacheSchema,
  canary: canarySchema,
  auth: routeAuthSchema,
});


export const serverSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(8080),
  workers: z.number().default(0), // 0 = auto (CPU count)
  trustProxy: z.boolean().default(true),
  // Peer socket addresses (post ::ffff:-normalization) allowed to supply X-Forwarded-For
  // even when trustProxy is false — e.g. a known internal load balancer's IP.
  trustedProxies: z.array(z.string()).optional(),
  connectTimeoutMs: z.number().default(5000),
  readTimeoutMs: z.number().default(15000),
  // Symmetric counterpart to the request body limit: caps how much of an upstream response
  // a worker will buffer in memory before aborting, so a huge/malicious upstream can't
  // exhaust worker memory.
  maxResponseBytes: z.number().default(25 * 1024 * 1024),
  // TCP listen() backlog — the OS-level queue of pending connections awaiting accept().
  // Node's own default (511) can drop/reset handshakes under a sudden burst of concurrent
  // connects; raise it for high-concurrency deployments.
  backlog: z.number().default(511),
  // Node's http.Server defaults these to 5000ms/60000ms. Under CPU contention (e.g. worker
  // count close to or exceeding core count), a persistent client connection can sit idle
  // past keepAliveTimeout purely from scheduling delay — the server then closes it, and a
  // client reusing that socket for its next request gets an immediate ECONNRESET rather than
  // a clean retry signal. Raising these gives contended workers more slack before that happens.
  keepAliveTimeoutMs: z.number().default(65000),
  headersTimeoutMs: z.number().default(66000),
  compression: z.boolean().default(false),
  // Backward-compatible properties with Zod defaults to prevent TypeScript compiler errors in legacy files
  listen: z.number().default(8080),
  httpsPort: z.number().optional(),
  sslKeyPath: z.string().optional(),
  sslCertPath: z.string().optional(),
  upstreams: z.array(upstreamSchema).default([]),
  paths: z.array(z.any()).default([]),
  loadBalancing: loadBalancerSchema,
  cache: cacheSchema,
  resilience: resilienceSchema,
  rateLimit: rateLimitSchema,
  discovery: discoverySchema,
  accessLog: z.string().optional(),
  eventLog: z.string().optional(),
  headers: z.array(z.any()).optional(),
});

export const tlsSchema = z
  .object({
    enabled: z.boolean().default(false),
    cert: z.string().default("./certs/cert.pem"),
    key: z.string().default("./certs/key.pem"),
    redirectHttp: z.boolean().default(true),
    httpsPort: z.number().default(8443),
  })
  .default({
    enabled: false,
    cert: "./certs/cert.pem",
    key: "./certs/key.pem",
    redirectHttp: true,
    httpsPort: 8443,
  });

export const rootConfigSchema = z.object({
  server: serverSchema,
  tls: tlsSchema,
  upstreams: z.array(upstreamSchema).default([]),
  routes: z.array(routeSchema).default([]),
  loadBalancing: loadBalancerSchema,
  resilience: resilienceSchema,
  rateLimit: rateLimitSchema,
  cache: cacheSchema,
  discovery: discoverySchema,
  observability: observabilitySchema,
  admin: adminSchema,
});

export type RootConfigType = z.infer<typeof rootConfigSchema>;
