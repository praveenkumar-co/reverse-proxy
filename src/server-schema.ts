import {z} from 'zod';

export const workerMessageSchema = z.object({
  requestType : z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  headers :  z.any(),
  body : z.string().nullable(),
  url : z.string(),
  requestId : z.string().optional()
});

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

// making type of worker Message Schema and Reply Schema of Workers
export type  WorkerMessageType = z.infer<typeof workerMessageSchema>;
export type WorkerReplyMessageType = z.infer<typeof workerMessageReplySchema>;
