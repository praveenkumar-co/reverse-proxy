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

  startSpan(name: string, traceId: string, attributes: Record<string, string> = {}): Span {
    const span: Span = {
      traceId,
      spanId: Math.random().toString(36).slice(2),
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
