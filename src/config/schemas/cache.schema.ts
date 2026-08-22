import { z } from "zod";

const debeziumMappingSchema = z.object({
  table: z.string(),
  pathPattern: z.string(),
});

const debeziumSchema = z
  .object({
    enabled: z.boolean().default(false),
    channel: z.string().default("debezium-db-changes"),
    mappings: z.array(debeziumMappingSchema).default([]),
  })
  .default({
    enabled: false,
    channel: "debezium-db-changes",
    mappings: [],
  });

export const cacheSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().default(6379),
    ttlSeconds: z.number().default(60),
    l1Enabled: z.boolean().default(true),
    l1MaxSize: z.number().default(10000),
    staleWhileRevalidate: z.boolean().default(true),
    staleIfError: z.boolean().default(true),
    key: z
      .object({
        ignoreQueryParams: z.array(z.string()).default([]),
        varyHeaders: z.array(z.string()).default(["Accept", "Accept-Encoding"]),
      })
      .default({
        ignoreQueryParams: [],
        varyHeaders: ["Accept", "Accept-Encoding"],
      }),
    debezium: debeziumSchema,
  })
  .default({
    enabled: false,
    host: "127.0.0.1",
    port: 6379,
    ttlSeconds: 60,
    l1Enabled: true,
    l1MaxSize: 10000,
    staleWhileRevalidate: true,
    staleIfError: true,
    key: {
      ignoreQueryParams: [],
      varyHeaders: ["Accept", "Accept-Encoding"],
    },
    debezium: {
      enabled: false,
      channel: "debezium-db-changes",
      mappings: [],
    },
  });

export type CacheConfigType = z.infer<typeof cacheSchema>;
