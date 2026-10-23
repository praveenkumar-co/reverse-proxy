import { generateSpanId } from "./w3c-trace-context.js";

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs?: number;
  attributes: Record<string, string>;
}
export class Tracer {
  private spans: Span[] = [];

  /**
   * Nothing currently drains `spans` via flush() in production — every request creates one via
   * tracingMiddleware — so without a cap this array grows for the lifetime of the worker
   * process. `maxSpans` bounds it as a ring buffer: oldest spans are dropped once exceeded.
   * Trimming in batches (rather than one at a time) keeps the amortized cost of startSpan() O(1).
   */
  constructor(private readonly maxSpans: number = 10_000){}

  /**
   * `spanId` is optional so callers that already minted a W3C-compliant span id (16 hex
   * chars, e.g. tracingMiddleware deriving one for the traceparent header) can hand it in
   * directly instead of this generating its own and the two diverging.
   */
  startSpan(name: string, traceId: string, attributes: Record<string, string> = {}, spanId?: string): Span {
    const span: Span = {
      traceId,
      spanId: spanId ?? generateSpanId(),
      name,
      startMs: Date.now(),
      attributes,
    };
    this.spans.push(span);
    if(this.spans.length > this.maxSpans){
      this.spans.splice(0, this.spans.length - this.maxSpans);
    }
    return span;
  }
  endSpan(span: Span){
    span.endMs = Date.now();
  }
  flush(): Span[] {
    const out = [...this.spans];
    this.spans = [];
    return out;
  }
}

export const tracer = new Tracer();
