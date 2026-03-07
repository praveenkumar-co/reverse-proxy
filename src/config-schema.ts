import { z } from 'zod';

const upstreamSchema = z.object({
    id: z.string(),
    url: z.string().url(),
});

const headerSchema = z.object({
    key: z.string(),
    value: z.string(),
});

const rateLimitSchema = z.object({
    windowMs : z.number(),
    maxRequests : z.number()
}).optional();

const pathRuleSchema = z.object({
    path: z.string(),
    upstream: z.array(z.string()),
    rateLimit : rateLimitSchema
});

const serverSchema = z.object({
    listen: z.number(),
    httpsPort: z.number().optional(),
    workers: z.number().optional(),
    upstreams: z.array(upstreamSchema),
    headers: z.array(headerSchema).optional(),
    paths: z.array(pathRuleSchema),
});

export const rootConfigSchema = z.object({
    server: serverSchema,
});

export type ConfigSchemaType = z.infer<typeof rootConfigSchema>