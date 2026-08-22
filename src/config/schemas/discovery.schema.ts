import { z } from "zod";

export const discoverySchema = z
  .object({
    mode: z.enum(["static", "dynamic"]).default("static"),
    heartbeatTtlMs: z.number().default(30000),
    health: z
      .object({
        active: z
          .object({
            enabled: z.boolean().default(true),
            intervalMs: z.number().default(10000),
            timeoutMs: z.number().default(2000),
            path: z.string().default("/health"),
            healthyThreshold: z.number().default(2),
            unhealthyThreshold: z.number().default(3),
          })
          .default({
            enabled: true,
            intervalMs: 10000,
            timeoutMs: 2000,
            path: "/health",
            healthyThreshold: 2,
            unhealthyThreshold: 3,
          }),
        passive: z
          .object({
            enabled: z.boolean().default(true),
          })
          .default({
            enabled: true,
          }),
      })
      .default({
        active: {
          enabled: true,
          intervalMs: 10000,
          timeoutMs: 2000,
          path: "/health",
          healthyThreshold: 2,
          unhealthyThreshold: 3,
        },
        passive: {
          enabled: true,
        },
      }),
  })
  .default({
    mode: "static",
    heartbeatTtlMs: 30000,
    health: {
      active: {
        enabled: true,
        intervalMs: 10000,
        timeoutMs: 2000,
        path: "/health",
        healthyThreshold: 2,
        unhealthyThreshold: 3,
      },
      passive: {
        enabled: true,
      },
    },
  });

export type DiscoveryConfigType = z.infer<typeof discoverySchema>;
