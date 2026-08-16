import { z } from "zod";

export const rateLimitSchema = z
  .object({
    windowMs: z.number().default(60000),
    maxRequests: z.number().default(5),
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
    softLimit: z.boolean().default(false),
  })
  .default({
    windowMs: 60000,
    maxRequests: 5,
    algorithm: "fixed-window",
    storage: "memory",
    softLimit: false,
  });

export type RateLimitConfigType = z.infer<typeof rateLimitSchema>;
