import http from 'http';
import https from 'https';

export interface ProxyRequestOptions {
  upstreamUrl: string;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body?: string | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  rejectUnauthorized?: boolean;
}

export interface ProxyResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function proxyRequest(opts: ProxyRequestOptions): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.upstreamUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request({
      host: url.hostname,
      port: url.port || (isHttps ? '443' : '80'),
      path: opts.path,
      method: opts.method,
      headers: opts.headers,
      rejectUnauthorized: opts.rejectUnauthorized ?? true,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 200,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });

    const connectTimer = setTimeout(() => {
      req.destroy();
      reject(new Error('Connect timeout'));
    }, opts.connectTimeoutMs);

    req.on('response', () => clearTimeout(connectTimer));
    req.on('error', (err) => { clearTimeout(connectTimer); reject(err); });

    if (opts.body) req.write(Buffer.from(opts.body, 'binary'));
    req.end();
  });
}
