import { z } from "zod";

export const loadBalancerSchema = z
  .object({
    strategy: z
      .enum([
        "round-robin",
        "weighted-round-robin",
        "least-connections",
        "weighted-least-connections",
        "least-response-time",
        "random",
        "ip-hash",
        "consistent-hashing",
        "power-of-two",
        "resource-based",
        "sticky-sessions",
        "adaptive-wrr",
      ])
      .default("least-connections"),
    failureThreshold: z.number().default(3),
    recoveryTimeMs: z.number().default(15000),
    virtualNodes: z.number().default(150),
    ewmaAlpha: z.number().default(0.1),
    stickyCookieName: z.string().default("NINJA_ROUTE"),
    stickyCookieTtlMs: z.number().optional(),
    maxConnections: z.number().optional(),
    slowStartSeconds: z.number().default(30),
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
    virtualNodes: 150,
    ewmaAlpha: 0.1,
    stickyCookieName: "NINJA_ROUTE",
    slowStartSeconds: 30,
    retry: {
      maxAttempts: 2,
      statusCodes: [502, 503, 504],
    },
  });

export type LoadBalancerConfigType = z.infer<typeof loadBalancerSchema>;
