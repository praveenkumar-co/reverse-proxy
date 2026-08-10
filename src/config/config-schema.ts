import { z } from "zod";

// Per-upstream TLS configuration.
// Enables HTTPS connections to upstream backends with fine-grained cert control.
const upstreamTlsSchema = z
  .object({
    // Default: true (strict certificate validation — required in production).
    // Set to false ONLY for development/test with self-signed certs.
    rejectUnauthorized: z.boolean().default(true),
    // Optional path to a PEM-encoded CA bundle for validating internal CAs.
    // Example: /etc/ssl/internal-ca.pem
    ca: z.string().optional(),
  })
  .optional();

const upstreamSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  weight: z.number().default(1),
  healthPath: z.string().default("/health"),
  // Optional TLS config. Only used when url scheme is https:// or wss://
  tls: upstreamTlsSchema,
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
  sticky: z.boolean().default(false),
});

const loadBalancerSchema = z
  .object({
    strategy: z
      .enum(["round-robin", "least-connections", "ip-hash", "random"])
      .default("least-connections"),
    failureThreshold: z.number().default(3),
    recoveryTimeMs: z.number().default(15000),
    retry: z
      .object({
        maxAttempts: z.number().default(2),
        statusCodes: z.array(z.number()).default([502, 503, 504]),
      })
      .default({
        maxAttempts: 2,
        statusCodes: [502, 503, 504],
      }),
  })
  .default({
    strategy: "least-connections",
    failureThreshold: 3,
    recoveryTimeMs: 15000,
    retry: {
      maxAttempts: 2,
      statusCodes: [502, 503, 504],
    },
  });

const cacheSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().default("redis"),
    port: z.number().default(6379),
    ttlSeconds: z.number().default(60),
  })
  .default({
    enabled: false,
    host: "redis",
    port: 6379,
    ttlSeconds: 60,
  });

const serverSchema = z.object({
  listen: z.number(),
  httpsPort: z.number().optional(),
  workers: z.number().optional(),
  connectTimeoutMs: z.number().default(5000),
  readTimeoutMs: z.number().default(15000),
  compression: z.boolean().default(false),
  accessLog: z.string().optional(),
  upstreams: z.array(upstreamSchema),
  headers: z.array(headerSchema).optional(),
  paths: z.array(pathRuleSchema),
  loadBalancing: loadBalancerSchema,
  cache: cacheSchema,
});

export const rootConfigSchema = z.object({
  server: serverSchema,
});

export type ConfigSchemaType = z.infer<typeof rootConfigSchema>;
export type UpstreamConfig = z.infer<typeof upstreamSchema>;
