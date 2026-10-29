import type { ServiceInstance } from "../../discovery/registry/dynamic.registry.js";

// -----------------------------------------------------------------------------
// Master <-> worker control-plane protocol (Phase B).
//
// Workers own the datapath entirely — they accept client connections directly
// (via cluster's shared-listen) and talk to upstreams directly. There is no
// IPC for request/response bodies any more. What's left is pure control
// plane: health/registry broadcast, registry mutation forwarding, metrics
// aggregation, in-memory rate-limit token leasing, and lifecycle signals.
// None of these are on the hot request path, so they aren't zod-validated —
// same as the pre-existing GRACEFUL_SHUTDOWN/DUMP_METRICS_* messages.
// -----------------------------------------------------------------------------

/** Master -> all workers. Broadcast whenever the registry or health set changes. */
export interface UpdateServicesMessage {
  type: "UPDATE_SERVICES";
  healthyUpstreams: string[];
  registry: ServiceInstance[];
}

/** Master -> workers (retiring) / workers -> self-drain. */
export interface GracefulShutdownMessage {
  type: "GRACEFUL_SHUTDOWN";
}

/** Master -> one worker, to collect its local metrics snapshot. */
export interface DumpMetricsRequestMessage {
  type: "DUMP_METRICS_REQUEST";
  requestId: string;
}

/** Worker -> master, reply to DUMP_METRICS_REQUEST. */
export interface DumpMetricsResponseMessage {
  type: "DUMP_METRICS_RESPONSE";
  requestId: string;
  data: any;
}

/** Worker -> master: "collect every worker's metrics snapshot for me" (GET /metrics). */
export interface MetricsAggregateRequestMessage {
  type: "METRICS_AGGREGATE_REQUEST";
  requestId: string;
}

/** Master -> requesting worker, reply to METRICS_AGGREGATE_REQUEST. */
export interface MetricsAggregateResponseMessage {
  type: "METRICS_AGGREGATE_RESPONSE";
  requestId: string;
  snapshots: any[];
}

/** Worker -> master: forward an admin registry mutation to the canonical registry. */
export interface RegistryMutateRequestMessage {
  type: "REGISTRY_MUTATE";
  requestId: string;
  action: "register" | "deregister" | "heartbeat";
  payload: any;
}

/** Master -> requesting worker, reply to REGISTRY_MUTATE. */
export interface RegistryMutateResponseMessage {
  type: "REGISTRY_MUTATE_RESPONSE";
  requestId: string;
  result?: any;
  error?: string;
}

/**
 * Worker -> master: "lease me up to a batch of request permits for this key" — used only
 * for in-memory-storage rate limiting (Redis-storage limiters talk to Redis directly from
 * each worker and never need master at all). Batching keeps master off the request hot path:
 * a worker only calls this when its locally-held permits for (scope,key) run out, not on
 * every request.
 */
export interface RlLeaseRequestMessage {
  type: "RL_LEASE_REQUEST";
  requestId: string;
  scope: string;
  key: string;
  windowMs: number;
  maxRequests: number;
  algorithm: string;
  softLimit?: number | boolean;
  burstMultiplier?: number;
}

/** Master -> requesting worker, reply to RL_LEASE_REQUEST. */
export interface RlLeaseResponseMessage {
  type: "RL_LEASE_RESPONSE";
  requestId: string;
  granted: number;
  resetAt: number;
  algorithm: string;
  algoState?: any;
}

export type MasterToWorkerMessage =
  | UpdateServicesMessage
  | GracefulShutdownMessage
  | DumpMetricsRequestMessage
  | MetricsAggregateResponseMessage
  | RegistryMutateResponseMessage
  | RlLeaseResponseMessage;

export type WorkerToMasterMessage =
  | DumpMetricsResponseMessage
  | MetricsAggregateRequestMessage
  | RegistryMutateRequestMessage
  | RlLeaseRequestMessage
  | GracefulShutdownMessage;
