import { z } from "zod";

export const adminSchema = z
  .object({
    enabled: z.boolean().default(true),
    pathPrefix: z.string().default("/__admin"),
    // Shared-secret for /__* control-plane endpoints. Also settable via ADMIN_SECRET env var.
    // When `enabled` is true and no token is configured, admin endpoints fail closed (reject all requests).
    token: z.string().optional(),
    // Exceptions to the default-deny policy for POST /__registry/register (admin.handler.ts's
    // assertSafeRegistrationUrl): every registration is rejected by default if it resolves to
    // a loopback/private/link-local/unspecified/multicast/broadcast/IPv4-mapped-IPv6 address,
    // regardless of this list. An entry here is either a CIDR or bare IP ("127.0.0.1/32",
    // "10.0.0.0/8", "::1/128") matched against the resolved address, or a hostname/domain
    // suffix (leading ".") matched against the URL's hostname — either form exempts that
    // specific address/host from the deny-by-default policy. A normal, public address is
    // always allowed and never needs an entry here. Config-file upstreams are never subject
    // to this check at all; it only gates the admin registration endpoint.
    registrationAllowlist: z.array(z.string()).default([]),
  })
  .default({
    enabled: true,
    pathPrefix: "/__admin",
    registrationAllowlist: [],
  });

export type AdminConfigType = z.infer<typeof adminSchema>;
