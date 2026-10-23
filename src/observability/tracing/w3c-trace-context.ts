import crypto from "node:crypto";

// W3C Trace Context: https://www.w3.org/TR/trace-context/
// traceparent = version "-" trace-id "-" parent-id "-" trace-flags
//   version:    2 hex chars (we only emit "00")
//   trace-id:   32 hex chars, not all zero
//   parent-id:  16 hex chars, not all zero (the span id of the *sender*)
//   trace-flags: 2 hex chars

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface ParsedTraceParent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** Returns undefined for a missing, malformed, or all-zero (invalid per spec) header. */
export function parseTraceParent(header: string | undefined): ParsedTraceParent | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match as unknown as [string, string, string, string, string];
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return undefined;
  return { version, traceId, spanId, flags };
}

export function buildTraceParent(traceId: string, spanId: string, flags = "01"): string {
  return `00-${traceId}-${spanId}-${flags}`;
}
