export interface KeyBuilderOptions {
  ignoreQueryParams?: string[];
  varyHeaders?: string[];
  prefix?: string;
}

export class KeyBuilder {
  constructor(private opts: KeyBuilderOptions = {}){}

  build(method: string, url: string, headers: Record<string, string> = {}): string {
    const qIndex = url.indexOf("?");
    const rawPath = qIndex >= 0 ? url.slice(0, qIndex) : url;
    const rawSearch = qIndex >= 0 ? url.slice(qIndex + 1) : "";
    const pathname = rawPath.startsWith("http://") || rawPath.startsWith("https://")
      ? new URL(rawPath).pathname
      : rawPath;
    const params = new URLSearchParams(rawSearch);
    for(const p of (this.opts.ignoreQueryParams ?? [])) params.delete(p);
    const qs = params.toString() ? `?${params.toString()}` : '';
    let key = `${this.opts.prefix ?? 'proxy'}:${method}:${pathname}${qs}`;
    for(const h of (this.opts.varyHeaders ?? [])){
      const val = headers[h.toLowerCase()] ?? '';
      key += `:${h}=${val}`;
    }
    return key;
  }
}
