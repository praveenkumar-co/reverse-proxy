import { z } from "zod";

export const adminSchema = z
  .object({
    enabled: z.boolean().default(true),
    pathPrefix: z.string().default("/__admin"),
    // Shared-secret for /__* control-plane endpoints. Also settable via ADMIN_SECRET env var.
    // When `enabled` is true and no token is configured, admin endpoints fail closed (reject all requests).
    token: z.string().optional(),
    // Hostnames (exact match) or domain suffixes (leading ".") allowed for
    // POST /__registry/register. Empty (the default) means no allowlist restriction beyond
    // the unconditional link-local/cloud-metadata block in admin.handler.ts — set this in any
    // deployment where tenants can reach the registration endpoint, so they can't point the
    // proxy at an arbitrary internal service.
    registrationAllowlist: z.array(z.string()).default([]),
  })
  .default({
    enabled: true,
    pathPrefix: "/__admin",
    registrationAllowlist: [],
  });

export type AdminConfigType = z.infer<typeof adminSchema>;
