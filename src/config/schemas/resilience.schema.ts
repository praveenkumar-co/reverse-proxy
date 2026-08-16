import { z } from "zod";

export const resilienceSchema = z
  .object({
    retry: z
      .object({
        backoff: z
          .enum([
            "exponential",
            "full-jitter",
            "equal-jitter",
            "decorrelated-jitter",
          ])
          .default("full-jitter"),
        baseDelayMs: z.number().default(100),
        maxDelayMs: z.number().default(5000),
        maxAttempts: z.number().default(4),
        budgetPercent: z.number().default(15),
      })
      .default({
        backoff: "full-jitter",
        baseDelayMs: 100,
        maxDelayMs: 5000,
        maxAttempts: 4,
        budgetPercent: 15,
      }),
    circuitBreaker: z
      .object({
        mode: z.enum(["classic", "adaptive"]).default("classic"),
        failureThreshold: z.number().default(3),
        recoveryTimeMs: z.number().default(15000),
        K: z.number().default(2),
        windowMs: z.number().default(10000),
      })
      .default({
        mode: "classic",
        failureThreshold: 3,
        recoveryTimeMs: 15000,
        K: 2,
        windowMs: 10000,
      }),
  })
  .default({
    retry: {
      backoff: "full-jitter",
      baseDelayMs: 100,
      maxDelayMs: 5000,
      maxAttempts: 4,
      budgetPercent: 15,
    },
    circuitBreaker: {
      mode: "classic",
      failureThreshold: 3,
      recoveryTimeMs: 15000,
      K: 2,
      windowMs: 10000,
    },
  });

export type ResilienceConfigType = z.infer<typeof resilienceSchema>;
