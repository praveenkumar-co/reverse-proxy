import { z } from "zod";

export const resilienceSchema = z
  .object({
    retry: z
      .object({
        enabled: z.boolean().default(true),
        maxAttempts: z.number().default(4),
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
        budgetPercent: z.number().default(15),
        retryOn: z
          .object({
            localNodeFailure: z.boolean().default(true),
            systemOverload: z.boolean().default(true),
          })
          .default({
            localNodeFailure: true,
            systemOverload: true,
          }),
        // Mutating methods (POST/PUT/PATCH/DELETE) are only auto-retried when the request
        // carries an Idempotency-Key header, unless this is explicitly set to true.
        retryMutatingMethods: z.boolean().default(false),
      })
      .default({
        enabled: true,
        maxAttempts: 4,
        backoff: "full-jitter",
        baseDelayMs: 100,
        maxDelayMs: 5000,
        budgetPercent: 15,
        retryOn: {
          localNodeFailure: true,
          systemOverload: true,
        },
        retryMutatingMethods: false,
      }),
    circuitBreaker: z
      .object({
        mode: z.enum(["classic", "adaptive"]).default("classic"),
        failureThreshold: z.number().default(3),
        recoveryTimeMs: z.number().default(15000),
        K: z.number().default(2),
        windowMs: z.number().default(10000),
        // Classic breaker only: concurrent trial requests allowed through while HALF_OPEN.
        // Keeping this low (default 1) is what prevents a recovering upstream from being
        // immediately slammed with full traffic and re-tripping.
        maxHalfOpenProbes: z.number().default(1),
      })
      .default({
        mode: "classic",
        failureThreshold: 3,
        recoveryTimeMs: 15000,
        K: 2,
        windowMs: 10000,
        maxHalfOpenProbes: 1,
      }),
    bulkhead: z
      .object({
        enabled: z.boolean().default(false),
        maxConcurrentPerUpstream: z.number().default(100),
      })
      .default({
        enabled: false,
        maxConcurrentPerUpstream: 100,
      }),
  })
  .default({
    retry: {
      enabled: true,
      maxAttempts: 4,
      backoff: "full-jitter",
      baseDelayMs: 100,
      maxDelayMs: 5000,
      budgetPercent: 15,
      retryOn: {
        localNodeFailure: true,
        systemOverload: true,
      },
      retryMutatingMethods: false,
    },
    circuitBreaker: {
      mode: "classic",
      failureThreshold: 3,
      recoveryTimeMs: 15000,
      K: 2,
      windowMs: 10000,
      maxHalfOpenProbes: 1,
    },
    bulkhead: {
      enabled: false,
      maxConcurrentPerUpstream: 100,
    },
  });

export type ResilienceConfigType = z.infer<typeof resilienceSchema>;
