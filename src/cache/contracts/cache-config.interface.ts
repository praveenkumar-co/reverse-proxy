export interface DebeziumMapping {
  table: string;
  pathPattern: string;
}

export interface DebeziumConfig {
  enabled: boolean;
  channel: string;
  mappings: DebeziumMapping[];
}

export interface CacheConfig {
  host: string;
  port: number;
  ttlSeconds: number;
  enabled: boolean;
  l1Enabled?: boolean;
  l1MaxSize?: number;
  staleWhileRevalidate?: boolean;
  staleIfError?: boolean;
  debezium?: DebeziumConfig;
}

export interface L1Entry {
  value: string;
  expiresAt: number;
}
