import { z } from "zod";

export const discoverySchema = z
  .object({
    heartbeatTimeoutMs: z.number().default(30000),
    cleanupIntervalMs: z.number().default(10000),
    persistencePath: z.string().default("proxy_registry_backup.json"),
  })
  .default({
    heartbeatTimeoutMs: 30000,
    cleanupIntervalMs: 10000,
    persistencePath: "proxy_registry_backup.json",
  });

export type DiscoveryConfigType = z.infer<typeof discoverySchema>;
