import http from "http";
import https from "https";
import { readFileSync } from "fs";
import type { ConfigSchemaType } from "../config/config-schema.js";
import { LoadBalancer } from "./load-balancer.js";
import { logger } from "../middleware/logger.js";

async function checkUpstream(
  upstream: ConfigSchemaType["server"]["upstreams"][number],
): Promise<boolean> {
  return new Promise((resolve) => {
    const upstreamUrl = new URL(upstream.url);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? https : http;

    const tlsConfig = upstream.tls;
    const rejectUnauthorized = tlsConfig?.rejectUnauthorized ?? true;

    if (isHttps && !rejectUnauthorized) {
      logger.warn("HealthCheck", "TLS certificate verification DISABLED", { id: upstream.id });
    }

    let caBuffer: Buffer | undefined;
    if (isHttps && tlsConfig?.ca) {
      try {
        caBuffer = readFileSync(tlsConfig.ca);
      } catch (err: any) {
        logger.error("HealthCheck", `Failed to read CA file: ${err.message}`, { id: upstream.id, ca: tlsConfig.ca });
      }
    }

    const req = transport.request(
      {
        host: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? "443" : "80"),
        path: upstream.healthPath ?? "/health",
        method: "GET",
        ...(isHttps && {
          rejectUnauthorized,
          ...(caBuffer ? { ca: caBuffer } : {}),
        }),
      },
      (res) => {
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

// Initial health check — runs once before the server starts accepting traffic
export async function initialHealthCheck(
  upstreams: ConfigSchemaType["server"]["upstreams"],
  HEALTHY_UPSTREAMS: Set<string>,
) {
  logger.info("HealthCheck", "Initial health check started");
  for (const upstream of upstreams) {
    const healthy = await checkUpstream(upstream);
    if (healthy) {
      logger.info("HealthCheck", `${upstream.id} is HEALTHY`);
      HEALTHY_UPSTREAMS.add(upstream.id);
    } else {
      logger.warn("HealthCheck", `${upstream.id} is NOT HEALTHY`);
      HEALTHY_UPSTREAMS.delete(upstream.id);
    }
  }
  logger.info("HealthCheck", "Initial check done", { healthy: [...HEALTHY_UPSTREAMS] });
}

// Periodic health check — runs on a fixed interval while the server is running
export function startHealthChecks(
  upstreams: ConfigSchemaType["server"]["upstreams"],
  HEALTHY_UPSTREAMS: Set<string>,
  lb: LoadBalancer,
) {
  logger.info("HealthCheck", "Periodic health checks started", { intervalMs: 10000 });
  setInterval(() => {
    logger.info("HealthCheck", "Checking all upstreams");
    for (const upstream of upstreams) {
      checkUpstream(upstream).then((healthy) => {
        if (healthy) {
          if (!HEALTHY_UPSTREAMS.has(upstream.id)) {
            HEALTHY_UPSTREAMS.add(upstream.id);
            logger.info("HealthCheck", `${upstream.id} back ONLINE`);
          } else {
            logger.info("HealthCheck", `${upstream.id} HEALTHY`);
          }
        } else {
          HEALTHY_UPSTREAMS.delete(upstream.id);
          logger.warn("HealthCheck", `${upstream.id} is DOWN`, { id: upstream.id });
        }
      });
    }
  }, 10000);
}
