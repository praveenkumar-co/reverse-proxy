import { z } from "zod";

export const workerMessageSchema = z.object({
  requestType: z.string(),
  headers: z.any(),
  body: z.string().nullable(),
  url: z.string(),
  requestId: z.string().optional(),
  clientIp: z.string().optional(),
});

// Control-plane-only reply: used when the worker never received any response from the
// upstream at all (route not found, upstream not found, connect/read timeout, connection
// error) — no body bytes exist to stream, so this still carries data as a single string.
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

// Streaming reply protocol for responses the upstream actually produced. Bodies never travel
// as a single buffered JSON string here — HEADERS is sent the moment upstream responds (so
// the master can start writing to the client immediately, fixing TTFB for SSE/long-poll),
// then zero or more CHUNK messages carry body bytes as they arrive (base64, so arbitrary
// binary survives JSON transport without the utf8 corruption of the old single-shot reply),
// then END finalizes the response. ABORT signals the response exceeded the worker's byte cap
// mid-stream, after headers (and possibly bytes) were already relayed to the client — at that
// point the only safe action left is to destroy the client connection, not send a clean error.
export const httpReplyHeadersSchema = z.object({
  type: z.literal("HTTP_REPLY_HEADERS"),
  requestId: z.string().optional(),
  statusCode: z.number(),
  headers: z.any(),
});

export const httpReplyChunkSchema = z.object({
  type: z.literal("HTTP_REPLY_CHUNK"),
  requestId: z.string().optional(),
  data: z.string(), // base64
});

export const httpReplyEndSchema = z.object({
  type: z.literal("HTTP_REPLY_END"),
  requestId: z.string().optional(),
});

export const httpReplyAbortSchema = z.object({
  type: z.literal("HTTP_REPLY_ABORT"),
  requestId: z.string().optional(),
  reason: z.string().optional(),
});

export type WorkerMessageType = z.infer<typeof workerMessageSchema>;
export type WorkerReplyMessageType = z.infer<typeof workerMessageReplySchema>;
export type HttpReplyHeadersType = z.infer<typeof httpReplyHeadersSchema>;
export type HttpReplyChunkType = z.infer<typeof httpReplyChunkSchema>;
export type HttpReplyEndType = z.infer<typeof httpReplyEndSchema>;
export type HttpReplyAbortType = z.infer<typeof httpReplyAbortSchema>;
