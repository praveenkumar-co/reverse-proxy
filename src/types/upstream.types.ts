export interface Upstream {
  id: string;
  url: string;
  weight?: number;
  healthPath?: string;
  maxConnections?: number;
  tls?: {
    rejectUnauthorized?: boolean;
    ca?: string;
  };
  metadata?: Record<string, string>;
}
