import http from "http";
import type { ConfigSchemaType } from "./config-schema.js";
import { LoadBalancer } from "./loadBalancer.js";

async function performHealthCheck(upstreamUrl: URL): Promise<boolean> {
  const checkPath = (path: string) => new Promise<boolean>((resolve) => {
    const req = http.request(
      {
        host: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: path,
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });

  const isHealthy = await checkPath("/health");
  if (isHealthy) return true;
  return await checkPath("/healthz");
}
// Initial health check 
export async function initialHealthCheck(
  upstreams: ConfigSchemaType["server"]["upstreams"],
  HEALTHY_UPSTREAMS: Set<string>
) {
  console.log(`Initial health check`);
  for (const upstream of upstreams) {
    const upstreamUrl = new URL(upstream.url);
    const isHealthy = await performHealthCheck(upstreamUrl);
    if (isHealthy) {
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

// before reverse Proxy health check
export async function startHealthChecks(
  upstreams: ConfigSchemaType["server"]["upstreams"],
  HEALTHY_UPSTREAMS: Set<string>,
  lb: LoadBalancer
) {
  console.log(`Check for health check before server response`);
  setInterval(async () => {
    console.log(`\n[HealthCheck] Checking all upstreams...`);
    for (const upstream of upstreams) {
      const upstreamUrl = new URL(upstream.url);
      const isHealthy = await performHealthCheck(upstreamUrl);
      if (isHealthy) {
        lb.recordSuccess(upstream.id);
        if (!HEALTHY_UPSTREAMS.has(upstream.id)) {
          HEALTHY_UPSTREAMS.add(upstream.id);
          if (!lb.hasUpstream(upstream.id)) {
            lb.addUpstream(upstream.id);
          }
          console.log(`${upstream.id} is back ONLINE!`);
        } else {
          console.log(`${upstream.id} is HEALTHY`);
        }
      } else {
        lb.recordFailure(upstream.id);
        HEALTHY_UPSTREAMS.delete(upstream.id);
        console.log(`${upstream.id} is DOWN!`);
      }
    }
  }, 10000);
}
