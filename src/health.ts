import http from "http";
import type { ConfigSchemaType } from "./config-schema.js";
import { LoadBalancer } from "./loadBalancer.js";

// Initial health check 
export async function initialHealthCheck(
  upstreams: ConfigSchemaType["server"]["upstreams"],
  HEALTHY_UPSTREAMS: Set<string>
) {
  console.log(`Initial health check`);
  for (const upstream of upstreams) {
    await new Promise<void>((resolve) => {
      const upstreamUrl = new URL(upstream.url);
      const req = http.request(
        {
          host: upstreamUrl.hostname,
          port: upstreamUrl.port,
          path: upstream.healthPath ?? "/health",
          method: "GET",
        },
        (initialRes) => {
          if (initialRes.statusCode === 200) {
            console.log(`${upstream.id} is HEALTHY`);
            HEALTHY_UPSTREAMS.add(upstream.id);
          } else {
            console.log(`${upstream.id} is NOT HEALTHY`);
            HEALTHY_UPSTREAMS.delete(upstream.id);
          }
          resolve();
        }
      );
      req.on("error", () => {
        console.log(`Some Error Occured`);
        console.log(`${upstream.id} is NOT HEALTHY`);
        HEALTHY_UPSTREAMS.delete(upstream.id);
        resolve();
      });
      req.end();
    });
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
  setInterval(() => {
    console.log(`\n[HealthCheck] Checking all upstreams...`);
    for (const upstream of upstreams) {
      const upstreamUrl = new URL(upstream.url);
      const req = http.request(
        {
          host: upstreamUrl.hostname, 
          port: upstreamUrl.port,
          path: upstream.healthPath ?? "/health",
          method: "GET",
        },
        (HealthRes) => {
          if (HealthRes.statusCode === 200) {
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
        });
      req.on('error', () => {
        lb.recordFailure(upstream.id);
        HEALTHY_UPSTREAMS.delete(upstream.id);
        console.log(`${upstream.id} is DOWN! (connection refused)`);
      });
      req.end();
    }
  }, 10000);
}
