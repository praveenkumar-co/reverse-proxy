import { z } from "zod";

const upstreamSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  weight: z.number().optional(),
});

const headerSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const rateLimitSchema = z
  .object({
    windowMs: z.number(),
    maxRequests: z.number(),
  })
  .optional();

const pathRuleSchema = z.object({
  path: z.string(),
  upstream: z.array(z.string()),
  rateLimit: rateLimitSchema,
});

const loadBalancerSchema = z
  .object({
    strategy: z
      .enum(["round-robin", "least-connections", "ip-hash", "random"])
      .default("least-connections"),
    failureThreshold: z.number().default(3),
    recoveryTimeMs: z.number().default(15000),
  })
  .default({
    strategy: "least-connections",
    failureThreshold: 3,
    recoveryTimeMs: 15000,
  });



const cacheSchema = z.object({
  enabled : z.boolean().default(false),
  host : z.string().default("redis"),
  port : z.number().default(6379),
  ttlSeconds: z.number().default(60),
}).default({
  enabled : false ,
  host : "redis",
  port : 6379 ,
  ttlSeconds : 60
});

const serverSchema = z.object({
  listen: z.number(),
  httpsPort: z.number().optional(),
  workers: z.number().optional(),
  upstreams: z.array(upstreamSchema),
  headers: z.array(headerSchema).optional(),
  paths: z.array(pathRuleSchema),
  loadBalancing: loadBalancerSchema,
  cache : cacheSchema ,
});

export const rootConfigSchema = z.object({
  server: serverSchema,
});

export type ConfigSchemaType = z.infer<typeof rootConfigSchema>;
