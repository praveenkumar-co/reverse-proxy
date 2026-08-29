import http from "http";
import https from "https";
import { readFileSync } from "fs";
import { logger } from "../../observability/logger/logger.js";

export async function checkUpstream(upstream: {
  id: string;
  url: string;
  healthPath?: string;
  tls?: { ca?: string; rejectUnauthorized?: boolean };
}): Promise<boolean> {
  return new Promise((resolve) => {
    const upstreamUrl = new URL(upstream.url);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const tlsConfig = upstream.tls;
    const rejectUnauthorized = tlsConfig?.rejectUnauthorized ?? true;
    if(isHttps && !rejectUnauthorized){
      logger.warn("HealthCheck", "TLS certificate verification DISABLED", { id: upstream.id });
    }
    let caBuffer: Buffer | undefined;
    if(isHttps && tlsConfig?.ca){
      try{
        caBuffer = readFileSync(tlsConfig.ca);
      }catch (err: any){
        logger.error("HealthCheck", `Failed to read CA file: ${err.message}`, { id: upstream.id, ca: tlsConfig.ca });
      }
    }
    const req = transport.request(
      {
        host: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? "443" : "80"),
        path: upstream.healthPath ?? "/health",
        method: "GET",
        timeout: 5000,
        ...(isHttps && {
          rejectUnauthorized,
          ...(caBuffer ? { ca: caBuffer } : {}),
        }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}
