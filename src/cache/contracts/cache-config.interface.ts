export interface DebeziumMapping {
  table: string;
  pathPattern: string;
}
export interface DebeziumConfig {
  enabled: boolean;
  channel: string;
  mappings: DebeziumMapping[];
}
export interface CacheKeyConfig {
  ignoreQueryParams?: string[];
  varyHeaders?: string[];
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
  // How long (seconds) a stale entry may still be served in place of an upstream error,
  // once staleIfError is enabled. Separate from ttlSeconds — the entry is already expired
  // for normal-hit purposes by the time this window is consulted.
  staleIfErrorSeconds?: number;
  key?: CacheKeyConfig;
  debezium?: DebeziumConfig;
}
export interface L1Entry {
  value: string;
  expiresAt: number;
}
