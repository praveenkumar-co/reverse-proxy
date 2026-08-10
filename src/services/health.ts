import http from "http";
import https from "https";
import { readFileSync } from "fs";
import type { ConfigSchemaType } from "../config/config-schema.js";
import { LoadBalancer } from "./load-balancer.js";

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
      console.warn(
        `[HealthCheck] WARNING: TLS certificate verification is DISABLED for upstream "${upstream.id}". ` +
          `This is acceptable for development but must NOT be used in production.`,
      );
    }

    let caBuffer: Buffer | undefined;
    if (isHttps && tlsConfig?.ca) {
      try {
        caBuffer = readFileSync(tlsConfig.ca);
      } catch (err: any) {
        console.error(
          `[HealthCheck] Failed to read CA file for upstream "${upstream.id}": ${err.message}`,
        );
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
  console.log(`Initial health check`);
  for (const upstream of upstreams) {
    const healthy = await checkUpstream(upstream);
    if (healthy) {
      console.log(`${upstream.id} is HEALTHY`);
      HEALTHY_UPSTREAMS.add(upstream.id);
    } else {
      console.log(`${upstream.id} is NOT HEALTHY`);
      HEALTHY_UPSTREAMS.delete(upstream.id);
    }
  }
  console.log(`Initial Health Check Done!`);
  console.log(`Healthy Upstreams: ${[...HEALTHY_UPSTREAMS].join(", ")}`);
}

// Periodic health check — runs on a fixed interval while the server is running
export function startHealthChecks(
  upstreams: ConfigSchemaType["server"]["upstreams"],
  HEALTHY_UPSTREAMS: Set<string>,
  lb: LoadBalancer,
) {
  console.log(`Check for health check before server response`);
  setInterval(() => {
    console.log(`\n[HealthCheck] Checking all upstreams...`);
    for (const upstream of upstreams) {
      checkUpstream(upstream).then((healthy) => {
        if (healthy) {
          if (!HEALTHY_UPSTREAMS.has(upstream.id)) {
            HEALTHY_UPSTREAMS.add(upstream.id);
            console.log(`${upstream.id} is back ONLINE!`);
          } else {
            console.log(`${upstream.id} is HEALTHY`);
          }
        } else {
          HEALTHY_UPSTREAMS.delete(upstream.id);
          console.log(`${upstream.id} is DOWN! (connection refused)`);
        }
      });
    }
  }, 10000);
}
