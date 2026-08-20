import { z } from "zod";
import { loadBalancerSchema } from "./balancer.schema.js";
import { cacheSchema } from "./cache.schema.js";
import { resilienceSchema } from "./resilience.schema.js";
import { rateLimitSchema } from "./ratelimit.schema.js";
import { discoverySchema } from "./discovery.schema.js";

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

const headerSchema = z.object({
  key: z.string(),
  value: z.string(),
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

const pathRuleSchema = z.object({
  path: z.string(),
  upstream: z.array(z.string()),
  rateLimit: pathRateLimitSchema,
  sticky: z.boolean().default(false),
  cache: z.object({ enabled: z.boolean().default(true), ttlSeconds: z.number().optional() }).optional(),
});

export const serverSchema = z.object({
  listen: z.number(),
  httpsPort: z.number().optional(),
  workers: z.number().optional(),
  connectTimeoutMs: z.number().default(5000),
  readTimeoutMs: z.number().default(15000),
  compression: z.boolean().default(false),
  accessLog: z.string().optional(),
  eventLog: z.string().optional(),
  sslKeyPath: z.string().optional(),
  sslCertPath: z.string().optional(),
  upstreams: z.array(upstreamSchema),
  headers: z.array(headerSchema).optional(),
  paths: z.array(pathRuleSchema),
  loadBalancing: loadBalancerSchema,
  cache: cacheSchema,
  resilience: resilienceSchema.optional(),
  rateLimit: rateLimitSchema.optional(),
  discovery: discoverySchema.optional(),
});

export const rootConfigSchema = z.object({
  server: serverSchema,
});

export type RootConfigType = z.infer<typeof rootConfigSchema>;
