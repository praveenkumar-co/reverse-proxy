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
    host: z.string().default("redis"),
    port: z.number().default(6379),
    ttlSeconds: z.number().default(60),
    l1Enabled: z.boolean().default(false),
    l1MaxSize: z.number().default(1000),
    staleWhileRevalidate: z.boolean().default(false),
    staleIfError: z.boolean().default(false),
    debezium: debeziumSchema,
  })
  .default({
    enabled: false,
    host: "redis",
    port: 6379,
    ttlSeconds: 60,
    l1Enabled: false,
    l1MaxSize: 1000,
    staleWhileRevalidate: false,
    staleIfError: false,
    debezium: {
      enabled: false,
      channel: "debezium-db-changes",
      mappings: [],
    },
  });

export type CacheConfigType = z.infer<typeof cacheSchema>;
