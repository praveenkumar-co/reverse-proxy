export interface UpstreamClientConfig {
  connectTimeoutMs: number;
  readTimeoutMs: number;
  rejectUnauthorized?: boolean;
}

export class UpstreamClient {
  constructor(private config: UpstreamClientConfig) {}

  getConfig(): UpstreamClientConfig {
    return this.config;
  }

  updateConfig(partial: Partial<UpstreamClientConfig>) {
    Object.assign(this.config, partial);
  }
}
