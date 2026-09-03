import { z } from "zod";

const rateLimitDimensionSchema = z.object({
  dimension: z.enum(["ip", "route", "api-key"]),
  maxRequests: z.number(),
  windowMs: z.number(),
});

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
      .default("fixed-window"),
    windowMs: z.number().default(60000),
    maxRequests: z.number().default(5),
    softLimit: z.boolean().default(false),
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
    dimensions: z.array(rateLimitDimensionSchema).optional(),
    headers: z.boolean().default(true),
  })
  .default({
    enabled: true,
    storage: "memory",
    algorithm: "fixed-window",
    windowMs: 60000,
    maxRequests: 5,
    softLimit: false,
    redis: {
      host: "127.0.0.1",
      port: 6379,
      keyPrefix: "rl:",
    },
    headers: true,
  });

export type RateLimitConfigType = z.infer<typeof rateLimitSchema>;
