import { z } from "zod";

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
      })
      .default({
        enabled: true,
        path: "/metrics",
        histograms: true,
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
  })
  .default({
    logging: { level: "info", accessLog: true },
    metrics: { enabled: true, path: "/metrics", histograms: true },
    tracing: { enabled: false, endpoint: "" },
  });

export type ObservabilityConfigType = z.infer<typeof observabilitySchema>;
