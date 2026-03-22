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

const autoScalingSchema = z.object({
  enabled: z.boolean().default(false),
  minServers: z.number().default(2),
  maxServers: z.number().default(10),
  scaleUpAt: z.number().default(10),
  scaleDownAt: z.number().default(2),
  cooldownMs: z.number().default(10000),
  startPort: z.number().default(9000),
  proxyPort: z.number().default(8080),
}).default({
    enabled : false ,
    minServers : 2 ,
    maxServers : 10,
    scaleUpAt : 10 ,
    scaleDownAt : 2 ,
    cooldownMs : 10000 ,
    startPort : 9000,
    proxyPort : 8080
});

const serverSchema = z.object({
  listen: z.number(),
  httpsPort: z.number().optional(),
  workers: z.number().optional(),
  upstreams: z.array(upstreamSchema),
  headers: z.array(headerSchema).optional(),
  paths: z.array(pathRuleSchema),
  loadBalancing: loadBalancerSchema,
  autoScaling: autoScalingSchema,
});

export const rootConfigSchema = z.object({
  server: serverSchema,
});

export type ConfigSchemaType = z.infer<typeof rootConfigSchema>;
