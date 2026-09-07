import { z } from "zod";

export const rateLimitSchema = z
  .object({
    enabled: z.boolean().default(true),
    storage: z.enum(["memory", "redis", "hybrid"]).default("memory"),
    algorithm: z
      .enum([
        "fixed-window",
        "sliding-window-log",
        "sliding-window-counter",
        "token-bucket",
        "leaking-bucket",
      ])
      .default("token-bucket"),
    windowMs: z.number().default(60000),
    maxRequests: z.number().default(1000),
    softLimit: z.union([z.number(), z.boolean()]).transform((v) => (typeof v === "number" ? v : undefined)).optional(),
    burstMultiplier: z.number().default(1.5).optional(),
    redis: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().default(6379),
        keyPrefix: z.string().default("rl:"),
      })
      .default({
        host: "127.0.0.1",
        port: 6379,
        keyPrefix: "rl:",
      }),
    headers: z.boolean().default(true),
  })
  .default({
    enabled: true,
    storage: "memory",
    algorithm: "token-bucket",
    windowMs: 60000,
    maxRequests: 1000,
    burstMultiplier: 1.5,
    redis: {
      host: "127.0.0.1",
      port: 6379,
      keyPrefix: "rl:",
    },
    headers: true,
  });

export type RateLimitConfigType = z.infer<typeof rateLimitSchema>;
