import { z } from "zod";

export const discoverySchema = z
  .object({
    heartbeatTimeoutMs: z.number().default(30000),
    cleanupIntervalMs: z.number().default(10000),
    persistencePath: z.string().default("proxy_registry_backup.json"),
    activeProbe: z
      .object({
        // A single transient probe blip shouldn't flap an upstream in/out of rotation —
        // require this many consecutive results before changing its marked status.
        consecutiveFailuresToTrip: z.number().default(2),
        consecutiveSuccessesToRecover: z.number().default(2),
      })
      .default({
        consecutiveFailuresToTrip: 2,
        consecutiveSuccessesToRecover: 2,
      }),
  })
  .default({
    heartbeatTimeoutMs: 30000,
    cleanupIntervalMs: 10000,
    persistencePath: "proxy_registry_backup.json",
    activeProbe: {
      consecutiveFailuresToTrip: 2,
      consecutiveSuccessesToRecover: 2,
    },
  });

export type DiscoveryConfigType = z.infer<typeof discoverySchema>;
