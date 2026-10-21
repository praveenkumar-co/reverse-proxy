import { checkUpstream } from "./active.probe.js";
import { passiveProbe } from "./passive.probe.js";
import { logger } from "../../observability/logger/logger.js";
import type { LoadBalancer } from "../../balancer/core/load-balancer.js";
export function registerPassiveProbeListener(
  HEALTHY_UPSTREAMS: Set<string>,
  lb: LoadBalancer,
  options: { failureStatusThreshold?: number; errorWindow?: number } = {}
){
  const failureStatusThreshold = options.failureStatusThreshold ?? 500;
  const errorCounts = new Map<string, number[]>();
  passiveProbe.onEvent((event) => {
    const isFailure = event.statusCode >= failureStatusThreshold;
    const upstreamId = event.upstreamId;
    if(isFailure){
      const now = Date.now();
      const window = options.errorWindow ?? 30_000;
      const timestamps = (errorCounts.get(upstreamId) ?? []).filter(t => now - t < window);
      timestamps.push(now);
      errorCounts.set(upstreamId, timestamps);
      if(timestamps.length >= 5){
        if(HEALTHY_UPSTREAMS.has(upstreamId)){
          HEALTHY_UPSTREAMS.delete(upstreamId);
          lb.setHealthy(upstreamId, false);
          logger.warn("PassiveProbe", `Marking ${upstreamId} DOWN passively (${timestamps.length} errors in ${window}ms window)`);
        }
      }
    }else {
      errorCounts.delete(upstreamId);
      if(!HEALTHY_UPSTREAMS.has(upstreamId)){
        HEALTHY_UPSTREAMS.add(upstreamId);
        lb.setHealthy(upstreamId, true);
        logger.info("PassiveProbe", `Marking ${upstreamId} UP passively (successful response observed)`);
      }
    }
  });
}

export async function initialHealthCheck(
  upstreams: Array<{ id: string; url: string; healthPath?: string; tls?: any }>,
  HEALTHY_UPSTREAMS: Set<string>,
  lb?: LoadBalancer,
){
  logger.info("HealthCheck", "Initial health check started");
  for(const upstream of upstreams){
    const healthy = await checkUpstream(upstream);
    if(healthy){
      logger.info("HealthCheck", `${upstream.id} is HEALTHY`);
      HEALTHY_UPSTREAMS.add(upstream.id);
      if (lb) lb.setHealthy(upstream.id, true);
    }else {
      logger.warn("HealthCheck", `${upstream.id} is NOT HEALTHY`);
      HEALTHY_UPSTREAMS.delete(upstream.id);
      if (lb) lb.setHealthy(upstream.id, false);
    }
  }
  logger.info("HealthCheck", "Initial check done", { healthy: [...HEALTHY_UPSTREAMS] });
}
interface ProbeStreak {
  consecutiveSuccesses: number;
  consecutiveFailures: number;
}

export function startHealthChecks(
  upstreams: Array<{ id: string; url: string; healthPath?: string; tls?: any }>,
  HEALTHY_UPSTREAMS: Set<string>,
  lb: LoadBalancer,
  intervalMs = 10000,
  options: { consecutiveFailuresToTrip?: number; consecutiveSuccessesToRecover?: number } = {},
): NodeJS.Timeout {
  const consecutiveFailuresToTrip = options.consecutiveFailuresToTrip ?? 2;
  const consecutiveSuccessesToRecover = options.consecutiveSuccessesToRecover ?? 2;
  // A single transient timeout/blip no longer flips status — each upstream must cross its
  // consecutive-result threshold first, mirroring the hysteresis the passive probe already has.
  const streaks = new Map<string, ProbeStreak>();

  logger.info("HealthCheck", "Periodic health checks started", {
    intervalMs,
    consecutiveFailuresToTrip,
    consecutiveSuccessesToRecover,
  });
  const handle = setInterval(() => {
    logger.info("HealthCheck", "Checking all upstreams");
    for(const upstream of upstreams){
      checkUpstream(upstream).then((probeHealthy) => {
        const streak = streaks.get(upstream.id) ?? { consecutiveSuccesses: 0, consecutiveFailures: 0 };
        if(probeHealthy){
          streak.consecutiveSuccesses++;
          streak.consecutiveFailures = 0;
        }else {
          streak.consecutiveFailures++;
          streak.consecutiveSuccesses = 0;
        }
        streaks.set(upstream.id, streak);

        const wasHealthy = HEALTHY_UPSTREAMS.has(upstream.id);
        if(!wasHealthy && probeHealthy && streak.consecutiveSuccesses >= consecutiveSuccessesToRecover){
          HEALTHY_UPSTREAMS.add(upstream.id);
          lb.setHealthy(upstream.id, true);
          logger.info(
            "HealthCheck",
            `${upstream.id} back ONLINE (${streak.consecutiveSuccesses} consecutive successes)`,
          );
        }else if(wasHealthy && !probeHealthy && streak.consecutiveFailures >= consecutiveFailuresToTrip){
          HEALTHY_UPSTREAMS.delete(upstream.id);
          lb.setHealthy(upstream.id, false);
          logger.warn(
            "HealthCheck",
            `${upstream.id} is DOWN (${streak.consecutiveFailures} consecutive failures)`,
            { id: upstream.id },
          );
        }else if(wasHealthy && !probeHealthy){
          logger.warn(
            "HealthCheck",
            `${upstream.id} probe failed (${streak.consecutiveFailures}/${consecutiveFailuresToTrip} before marking DOWN)`,
            { id: upstream.id },
          );
        }else if(!wasHealthy && probeHealthy){
          logger.info(
            "HealthCheck",
            `${upstream.id} probe succeeded (${streak.consecutiveSuccesses}/${consecutiveSuccessesToRecover} before marking UP)`,
            { id: upstream.id },
          );
        }
      });
    }
  }, intervalMs);
  return handle;
}
