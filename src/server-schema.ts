import {z} from 'zod';

export const workerMessageSchema = z.object({
  requestType : z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  headers :  z.any(),
  body : z.string().nullable(), // either body would be null or
  url : z.string(), 
});

export const workerMessageReplySchema = z.object({
    data: z.string(),
    error: z.string(),  
    errorCode: z.enum(['500', '404']).optional(),
});

// making type of worker Message Schema and Reply Schema of Workers
export type  WorkerMessageType = z.infer<typeof workerMessageSchema>;
export type WorkerReplyMessageType = z.infer<typeof workerMessageReplySchema>;
