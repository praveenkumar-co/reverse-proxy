import { z } from "zod";

// IPC message sent from Master → Worker for each proxied request
export const workerMessageSchema = z.object({
  requestType: z.enum(["GET", "POST", "PUT", "DELETE"]),
  headers: z.any(),
  body: z.string().nullable(),
  url: z.string(),
  requestId: z.string().optional(),
});

// IPC reply sent from Worker → Master after proxying completes
export const workerMessageReplySchema = z.object({
  requestId: z.string().optional(),
  data: z.string(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  statusCode: z.number().optional(),
  isCompressed: z.boolean().optional(),
  encoding: z.string().optional(),
  headers: z.any().optional(),
});

export type WorkerMessageType = z.infer<typeof workerMessageSchema>;
export type WorkerReplyMessageType = z.infer<typeof workerMessageReplySchema>;
