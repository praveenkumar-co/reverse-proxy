import { z } from "zod";

export const tenantEndpointSchema = z.object({
  tenantId: z.string(),
  destination: z.string().url(),
});

export const tenantDeliverySchema = z
  .object({
    mode: z.enum(["webhook", "none"]).default("none"),
    exportEndpoints: z.array(tenantEndpointSchema).default([]),
  })
  .default({
    mode: "none",
    exportEndpoints: [],
  });
export const observabilitySchema = z
  .object({
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        accessLog: z.union([z.boolean(), z.string()]).default(true),
      })
      .default({
        level: "info",
        accessLog: true,
      }),
    metrics: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().default("/metrics"),
        histograms: z.boolean().default(true),
        perTenantMetrics: z.boolean().default(false),
      })
      .default({
        enabled: true,
        path: "/metrics",
        histograms: true,
        perTenantMetrics: false,
      }),
    tracing: z
      .object({
        enabled: z.boolean().default(false),
        endpoint: z.string().default(""),
      })
      .default({
        enabled: false,
        endpoint: "",
      }),
    tenantDelivery: tenantDeliverySchema.optional(),
  })
  .default({
    logging: { level: "info", accessLog: true },
    metrics: { enabled: true, path: "/metrics", histograms: true, perTenantMetrics: false },
    tracing: { enabled: false, endpoint: "" },
    tenantDelivery: { mode: "none", exportEndpoints: [] },
  });

export type ObservabilityConfigType = z.infer<typeof observabilitySchema>;
