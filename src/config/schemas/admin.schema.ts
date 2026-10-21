import { z } from "zod";

export const adminSchema = z
  .object({
    enabled: z.boolean().default(true),
    pathPrefix: z.string().default("/__admin"),
    // Shared-secret for /__* control-plane endpoints. Also settable via ADMIN_SECRET env var.
    // When `enabled` is true and no token is configured, admin endpoints fail closed (reject all requests).
    token: z.string().optional(),
  })
  .default({
    enabled: true,
    pathPrefix: "/__admin",
  });

export type AdminConfigType = z.infer<typeof adminSchema>;
