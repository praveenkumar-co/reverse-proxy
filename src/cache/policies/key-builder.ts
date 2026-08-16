export interface KeyBuilderOptions {
  ignoreQueryParams?: string[];
  varyHeaders?: string[];
  prefix?: string;
}

export class KeyBuilder {
  constructor(private opts: KeyBuilderOptions = {}) {}

  build(method: string, url: string, headers: Record<string, string> = {}): string {
    const parsed = new URL(url, 'http://dummy');
    const params = new URLSearchParams(parsed.search);
    for (const p of (this.opts.ignoreQueryParams ?? [])) params.delete(p);
    const qs = params.toString() ? `?${params.toString()}` : '';
    let key = `${this.opts.prefix ?? 'proxy'}:${method}:${parsed.pathname}${qs}`;
    for (const h of (this.opts.varyHeaders ?? [])) {
      const val = headers[h.toLowerCase()] ?? '';
      key += `:${h}=${val}`;
    }
    return key;
  }
}
