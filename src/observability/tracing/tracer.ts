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
  startSpan(name: string, traceId: string, attributes: Record<string, string> = {}): Span {
    const span: Span = {
      traceId,
      spanId: Math.random().toString(36).slice(2),
      name,
      startMs: Date.now(),
      attributes,
    };
    this.spans.push(span);
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
