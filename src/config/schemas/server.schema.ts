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

const routeSchema = z.object({
  path: z.string(),
  upstreams: z.array(z.string()),
  rateLimit: pathRateLimitSchema,
  sticky: z.boolean().default(false),
  cache: pathCacheSchema,
});

export const serverSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(8080),
  workers: z.number().default(0), // 0 = auto (CPU count)
  trustProxy: z.boolean().default(true),
  connectTimeoutMs: z.number().default(5000),
  readTimeoutMs: z.number().default(15000),
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
