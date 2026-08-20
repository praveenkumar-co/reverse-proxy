export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body?: string | null;
  clientIp: string;
}

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer | string;
  latencyMs: number;
}