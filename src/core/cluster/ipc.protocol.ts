import { z } from "zod";

export const workerMessageSchema = z.object({
  requestType: z.string(),
  headers: z.any(),
  body: z.string().nullable(),
  url: z.string(),
  requestId: z.string().optional(),
  clientIp: z.string().optional(),
});

export const workerMessageReplySchema = z.object({
  requestId: z.string().optional(),
  data: z.string(),
  error: z.string().optional(),
  errorCode: z.string().optional(),3
  headers: z.any().optional(),
});

export type WorkerMessageType = z.infer<typeof workerMessageSchema>;
export type WorkerReplyMessageType = z.infer<typeof workerMessageReplySchema>;
