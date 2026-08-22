import { z } from "zod";

export const adminSchema = z
  .object({
    enabled: z.boolean().default(true),
    pathPrefix: z.string().default("/__admin"),
  })
  .default({
    enabled: true,
    pathPrefix: "/__admin",
  });

export type AdminConfigType = z.infer<typeof adminSchema>;
