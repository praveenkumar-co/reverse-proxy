import http from "http";
import https from "https";
import { readFileSync } from "fs";
import zlib from "zlib";
import { rootConfigSchema } from "../../config/schemas/server.schema.js";
import {
  workerMessageSchema,
  type WorkerReplyMessageType,
  type HttpReplyHeadersType,
  type HttpReplyChunkType,
  type HttpReplyEndType,
  type HttpReplyAbortType,
} from "./ipc.protocol.js";
import { logger } from "../../observability/logger/logger.js";
import { tunnelWebSocket } from "../proxy/websocket.handler.js";
import net from "net";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { writeAccessLog } from "../../observability/logger/logger.js";
import { tenantLogStreamer } from "../../observability/logger/tenant-log.streamer.js";
import { getAgent } from "../proxy/connection.pool.js";
import { RouteMatcher } from "../router/route.matcher.js";
import type { RouteRule } from "../router/route.types.js";

let workerConfig: Awaited<ReturnType<typeof rootConfigSchema.parseAsync>>;
try {
  const rawAppConfig = JSON.parse(process.env["APP_CONFIG"]!);
  workerConfig = await rootConfigSchema.parseAsync(rawAppConfig);
} catch (err: any) {
  logger.error(`Worker:${process.pid}`, `Fatal: invalid APP_CONFIG at startup — ${err.message}`);
  process.exit(1);
}
const routeMatcher = new RouteMatcher(workerConfig.server.paths as RouteRule[]);
const maxResponseBytes = workerConfig.server.maxResponseBytes ?? 25 * 1024 * 1024;
const healthyUpstreams = new Set<string>(workerConfig.server.upstreams.map((u) => u.id));
const metricsRegistry = new MetricsRegistry(healthyUpstreams);
if (workerConfig.observability?.tenantDelivery?.mode === "webhook") {
  tenantLogStreamer.configure(workerConfig.observability.tenantDelivery.exportEndpoints);
}

// Tracks in-flight upstream requests by requestId so (a) a client abort (relayed from master
// as ABORT_REQUEST) can immediately destroy the matching upstream socket instead of letting it
// run to completion for nobody, and (b) GRACEFUL_SHUTDOWN can wait for genuinely in-flight work
// to finish before this process exits, rather than hard-killing mid-request.
interface ActiveRequestEntry {
  proxyReq: http.ClientRequest;
  clearTimers: () => void;
}
const activeRequests = new Map<string, ActiveRequestEntry>();
// Covers the race where master's ABORT_REQUEST for a requestId arrives before the request
// itself (the real payload send is deferred one tick behind the abort listener registration —
// see dispatchToWorker's setImmediate in master.ts) — remembered briefly so the request, if it
// still arrives, is dropped instead of started. Entries expire after 30s so this can never grow
// unbounded from an abort whose matching request never shows up at all.
const abortedBeforeArrival = new Set<string>();
let draining = false;

function maybeExitWhenDrained() {
  if (draining && activeRequests.size === 0) {
    logger.info(`Worker:${process.pid}`, "Drain complete — exiting");
    process.exit(0);
  }
}

function safeProcessSend(msg: string, onSent?: () => void): void {
  if (!process.send) {
    onSent?.();
    return;
  }
  // process.send() returning false means Node's own IPC channel buffer is over its high
  // water mark — the message is still queued and will be delivered by Node itself. It does
  // NOT mean the send failed. Re-sending here (as this used to) put a second copy of the same
  // message on the wire under backpressure, which is what caused duplicate upstream POSTs
  // under concurrent load — the worker-side half of the same bug as master.ts's workerSend.
  // The optional callback form tells us when this specific write actually completed, which is
  // what graceful-shutdown draining needs (so the process doesn't exit before its last reply
  // is flushed) without resending anything.
  try {
    process.send(msg, onSent as any);
  } catch {
    onSent?.();
  }
}

function sendReplyAndCleanup(requestId: string | undefined, reply: Record<string, unknown>) {
  if (requestId) activeRequests.delete(requestId);
  safeProcessSend(JSON.stringify(reply), () => maybeExitWhenDrained());
}

process.on("message", async (rawMsg: any, handle?: any) => {
  try {
    const parsed = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
    if (!parsed) {
      return;
    }

    if (parsed.type === "GRACEFUL_SHUTDOWN") {
      logger.info(
        `Worker:${process.pid}`,
        `Gracefully draining connections (${activeRequests.size} in flight)`,
      );
      draining = true;
      maybeExitWhenDrained();
      return;
    }

    if (parsed.type === "ABORT_REQUEST") {
      const entry = parsed.requestId ? activeRequests.get(parsed.requestId) : undefined;
      if (entry) {
        logger.info(`Worker:${process.pid}`, "Aborting in-flight upstream request — client disconnected", {
          requestId: parsed.requestId,
        });
        entry.clearTimers();
        entry.proxyReq.destroy();
        activeRequests.delete(parsed.requestId);
        maybeExitWhenDrained();
      } else if (parsed.requestId) {
        const requestId = parsed.requestId;
        abortedBeforeArrival.add(requestId);
        setTimeout(() => abortedBeforeArrival.delete(requestId), 30_000);
      }
      return;
    }

    if (parsed.type === "DUMP_METRICS_REQUEST") {
      process.send?.(
        JSON.stringify({
          type: "DUMP_METRICS_RESPONSE",
          requestId: parsed.requestId,
          data: metricsRegistry.getSnapshot(),
        }),
      );
      return;
    }

    if (parsed.type === "UPDATE_SERVICES") {
      healthyUpstreams.clear();
      if (parsed.healthyUpstreams && Array.isArray(parsed.healthyUpstreams)) {
        for (const id of parsed.healthyUpstreams) {
          healthyUpstreams.add(id);
        }
      }
      return;
    }

    if (parsed.type === "WEBSOCKET_UPGRADE" && handle) {
      try {
        const clientSocket = handle as net.Socket;
        const head = Buffer.from(parsed.head, "base64");
        const upstreamStaticConfig = workerConfig.server.upstreams.find(
          (u) => u.id === parsed.upstreamId,
        );
        const tlsConfig = upstreamStaticConfig?.tls;
        logger.info(
          `Worker:${process.pid}`,
          "Received WebSocket socket handle handoff from master",
          {
            url: parsed.reqFields.url,
            upstreamId: parsed.upstreamId,
          },
        );
        tunnelWebSocket(clientSocket, parsed.upstreamUrl, parsed.reqFields, head, tlsConfig, () => {
          if (process.send) {
            process.send(
              JSON.stringify({
                type: "WEBSOCKET_CLOSED",
                upstreamId: parsed.upstreamId,
              }),
            );
          }
        });
      } catch (err: any) {
        logger.error(`Worker:${process.pid}`, `Websocket handoff failed: ${err.message}`);
      }
      return;
    }

    let msg;
    try {
      msg = await workerMessageSchema.parseAsync(parsed);
    } catch {
      return;
    }

    const raw = parsed as {
      upstreamId?: string;
      upstreamUrl?: string;
      requestId?: string;
    };
    if (raw.requestId && abortedBeforeArrival.delete(raw.requestId)) {
      logger.info(`Worker:${process.pid}`, "Dropping request whose abort arrived first — client already disconnected", {
        requestId: raw.requestId,
      });
      return;
    }
    const upstreamUrl: string | undefined = raw.upstreamUrl;
    const requestUrl = msg.url;
    // Query params must never influence route lookup — only the path prefix should.
    const cleanPath = (msg.url || "/").split("?")[0] ?? "/";
    const startTime = performance.now();
    const rule = routeMatcher.match(cleanPath, msg.requestType);
    if (!rule) {
      const reply: WorkerReplyMessageType = {
        requestId: raw.requestId,
        errorCode: "404",
        error: "Route not found",
        data: "",
      };
      sendReplyAndCleanup(raw.requestId, reply);
      return;
    }
    let finalUpstreamUrl: URL;
    if (upstreamUrl) {
      finalUpstreamUrl = new URL(upstreamUrl);
    } else {
      const upstream = workerConfig.server.upstreams.find((e) => e.id === rule.upstream[0]);
      if (!upstream) {
        const reply: WorkerReplyMessageType = {
          requestId: raw.requestId,
          errorCode: "500",
          error: "Upstream not found",
          data: "",
        };
        sendReplyAndCleanup(raw.requestId, reply);
        return;
      }
      finalUpstreamUrl = new URL(upstream.url);
    }
    const isHttps = finalUpstreamUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const agent = getAgent(isHttps);
    const upstreamStaticConfig = workerConfig.server.upstreams.find(
      (u) =>
        u.url === finalUpstreamUrl.toString() || new URL(u.url).origin === finalUpstreamUrl.origin,
    );
    const tlsConfig = upstreamStaticConfig?.tls;
    const rejectUnauthorized = tlsConfig?.rejectUnauthorized ?? true;
    if (isHttps && !rejectUnauthorized) {
      logger.warn(`Worker:${process.pid}`, "TLS certificate verification DISABLED", {
        host: finalUpstreamUrl.host,
      });
    }
    let caBuffer: Buffer | undefined;
    if (isHttps && tlsConfig?.ca) {
      try {
        caBuffer = readFileSync(tlsConfig.ca);
      } catch (err: any) {
        logger.error(`Worker:${process.pid}`, `Failed to read CA file: ${err.message}`, {
          ca: tlsConfig.ca,
        });
      }
    }
    const recordAndLog = (statusCode: number, bytesSent: number, latencyMs: number) => {
      const tenantId = (msg.headers["x-tenant-id"] as string) ?? "none";
      metricsRegistry.recordRequest(
        msg.requestType,
        rule.path,
        statusCode,
        raw.upstreamId || "unknown",
        latencyMs,
        tenantId,
      );
      const logPath =
        workerConfig.observability?.logging?.accessLog === true
          ? "logs/access.log"
          : typeof workerConfig.observability?.logging?.accessLog === "string"
            ? workerConfig.observability.logging.accessLog
            : undefined;
      if (logPath) {
        void writeAccessLog(
          logPath,
          msg.clientIp || "unknown",
          msg.requestType,
          msg.url,
          statusCode,
          bytesSent,
          latencyMs,
          (msg.headers["user-agent"] as string) ?? "-",
        );
      }
      if (workerConfig.observability?.tenantDelivery?.mode === "webhook") {
        tenantLogStreamer.queueLog(tenantId, {
          timestamp: new Date().toISOString(),
          clientIp: msg.clientIp || "unknown",
          method: msg.requestType,
          url: msg.url,
          statusCode,
          bytesSent,
          latencyMs,
          userAgent: (msg.headers["user-agent"] as string) ?? "-",
        });
      }
    };
    let connectTimeoutTimer: NodeJS.Timeout;
    let readTimeoutTimer: NodeJS.Timeout;
    const forwardHeaders: Record<string, any> = { ...msg.headers };
    delete forwardHeaders["transfer-encoding"];
    delete forwardHeaders["connection"];
    delete forwardHeaders["keep-alive"];
    forwardHeaders["host"] = finalUpstreamUrl.host;
    forwardHeaders["X-Real-IP"] = msg.clientIp || "unknown";
    forwardHeaders["X-Forwarded-For"] = msg.headers["x-forwarded-for"]
      ? `${msg.headers["x-forwarded-for"]}, ${msg.clientIp || "unknown"}`
      : msg.clientIp || "unknown";
    forwardHeaders["X-Forwarded-Proto"] =
      msg.headers["x-forwarded-proto"] || (isHttps ? "https" : "http");
    forwardHeaders["X-Forwarded-Host"] =
      msg.headers["x-forwarded-host"] || msg.headers["host"] || "localhost";
    forwardHeaders["X-Forwarded-Port"] =
      msg.headers["x-forwarded-port"] ||
      String(workerConfig.server.port || workerConfig.server.listen || (isHttps ? 8443 : 8080));
    if (msg.headers["x-trace-id"]) {
      forwardHeaders["X-Trace-Id"] = msg.headers["x-trace-id"];
    }
    forwardHeaders["X-Proxy-By"] = "Ninja-Reverse-Proxy";

    if (workerConfig.server.headers) {
      for (const h of workerConfig.server.headers) {
        forwardHeaders[h.key] = h.value === "client_ip" ? msg.clientIp || "unknown" : h.value;
      }
    }

    if (msg.body) {
      // msg.body is the binary-safe latin1 ("binary") encoding master.ts uses to relay
      // arbitrary request bytes through JSON — Buffer.byteLength's default utf8 encoding
      // would overcount any byte >= 0x80, understating how much data proxyReq.write()
      // actually sends below and leaving the upstream's parser waiting for bytes that will
      // never arrive.
      forwardHeaders["content-length"] = Buffer.byteLength(msg.body, "binary").toString();
    }

    const requestOptions: http.RequestOptions = {
      host: finalUpstreamUrl.hostname,
      port: finalUpstreamUrl.port || (isHttps ? "443" : "80"),
      path: requestUrl,
      method: msg.requestType,
      agent,
      headers: forwardHeaders,
      ...(isHttps && {
        rejectUnauthorized,
        ...(caBuffer ? { ca: caBuffer } : {}),
      }),
    };
    const finalizeActiveRequest = () => {
      if (raw.requestId) activeRequests.delete(raw.requestId);
      maybeExitWhenDrained();
    };
    const proxyReq = transport.request(requestOptions, (upstreamRes) => {
      clearTimeout(connectTimeoutTimer);
      const statusCode = upstreamRes.statusCode ?? 200;
      const isErrorish = statusCode >= 400;

      if (isErrorish) {
        // Error-ish responses stay fully buffered: master.ts's retry/stale-if-error decision
        // needs the complete body before it can choose to retry, serve a cached fallback, or
        // relay the error as-is — and once that decision is made it may discard this body
        // entirely, which only works if nothing has been written to the client yet. Error
        // bodies are small in practice, so buffering them costs nothing, unlike a success body
        // (which streams below).
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let aborted = false;
        upstreamRes.on("data", (chunk: Buffer) => {
          if (aborted) return;
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            aborted = true;
            clearTimeout(readTimeoutTimer);
            upstreamRes.destroy();
            proxyReq.destroy();
            logger.error(
              `Worker:${process.pid}`,
              `Upstream response exceeded ${maxResponseBytes}-byte cap — aborting`,
              { upstreamId: raw.upstreamId, url: requestUrl },
            );
            recordAndLog(502, receivedBytes, performance.now() - startTime);
            const reply: WorkerReplyMessageType = {
              requestId: raw.requestId,
              errorCode: "502",
              error: "Upstream response exceeded maximum allowed size",
              data: "",
            };
            sendReplyAndCleanup(raw.requestId, reply);
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on("end", () => {
          if (aborted) return;
          clearTimeout(readTimeoutTimer);
          const bodyBuffer = Buffer.concat(chunks);
          const latency = performance.now() - startTime;
          recordAndLog(statusCode, bodyBuffer.length, latency);
          const reply: WorkerReplyMessageType = {
            requestId: raw.requestId,
            // Binary-safe latin1 round-trip through JSON — unlike utf8, it never mangles a
            // byte sequence that happens to be invalid UTF-8 (e.g. a binary error body).
            data: bodyBuffer.toString("binary"),
            statusCode,
            headers: { ...upstreamRes.headers },
          };
          sendReplyAndCleanup(raw.requestId, reply);
        });
        return;
      }

      // Success-ish response: stream headers, then body chunks, then end, as they arrive —
      // so time-to-first-byte tracks the upstream's own TTFB (required for SSE/long-poll)
      // instead of waiting for the whole body, and a large body is never buffered whole in
      // worker memory.
      const acceptEncoding = msg.headers["accept-encoding"] || "";
      const contentType = String(upstreamRes.headers["content-type"] || "");
      const isCompressible = /json|text|javascript|css/.test(contentType);
      const upstreamEncoding = upstreamRes.headers["content-encoding"];
      // Only ever recompress a response the upstream sent uncompressed. An already-compressed
      // upstream response is passed through untouched — bytes and Content-Encoding both —
      // instead of being decompressed and (sometimes) recompressed as it was before.
      const shouldGzip =
        !upstreamEncoding &&
        Boolean(workerConfig.server.compression) &&
        isCompressible &&
        acceptEncoding.includes("gzip");

      const replyHeaders: Record<string, any> = { ...upstreamRes.headers };
      if (shouldGzip) {
        replyHeaders["content-encoding"] = "gzip";
        delete replyHeaders["content-length"]; // length changes once recompressed
      }

      safeProcessSend(
        JSON.stringify({
          type: "HTTP_REPLY_HEADERS",
          requestId: raw.requestId,
          statusCode,
          headers: replyHeaders,
        } satisfies HttpReplyHeadersType),
      );

      let streamedBytes = 0;
      let aborted = false;

      const resetReadTimeout = () => {
        clearTimeout(readTimeoutTimer);
        readTimeoutTimer = setTimeout(() => {
          aborted = true;
          upstreamRes.destroy();
          proxyReq.destroy();
          logger.warn(`Worker:${process.pid}`, "Upstream response stalled — aborting stream", {
            upstreamId: raw.upstreamId,
          });
          safeProcessSend(
            JSON.stringify({
              type: "HTTP_REPLY_ABORT",
              requestId: raw.requestId,
              reason: "read timeout",
            } satisfies HttpReplyAbortType),
            finalizeActiveRequest,
          );
        }, workerConfig.server.readTimeoutMs);
      };
      resetReadTimeout();

      const abortOversized = () => {
        aborted = true;
        clearTimeout(readTimeoutTimer);
        upstreamRes.destroy();
        proxyReq.destroy();
        logger.error(
          `Worker:${process.pid}`,
          `Upstream response exceeded ${maxResponseBytes}-byte cap mid-stream — aborting connection`,
          { upstreamId: raw.upstreamId, url: requestUrl },
        );
        recordAndLog(statusCode, streamedBytes, performance.now() - startTime);
        safeProcessSend(
          JSON.stringify({
            type: "HTTP_REPLY_ABORT",
            requestId: raw.requestId,
            reason: "response exceeded maximum allowed size",
          } satisfies HttpReplyAbortType),
          finalizeActiveRequest,
        );
      };

      const sendChunk = (buf: Buffer) => {
        streamedBytes += buf.length;
        if (streamedBytes > maxResponseBytes) {
          abortOversized();
          return;
        }
        safeProcessSend(
          JSON.stringify({
            type: "HTTP_REPLY_CHUNK",
            requestId: raw.requestId,
            data: buf.toString("base64"),
          } satisfies HttpReplyChunkType),
        );
      };

      const finishStream = () => {
        if (aborted) return;
        clearTimeout(readTimeoutTimer);
        const latency = performance.now() - startTime;
        recordAndLog(statusCode, streamedBytes, latency);
        safeProcessSend(
          JSON.stringify({ type: "HTTP_REPLY_END", requestId: raw.requestId } satisfies HttpReplyEndType),
          finalizeActiveRequest,
        );
      };

      upstreamRes.on("error", () => {
        if (aborted) return;
        aborted = true;
        clearTimeout(readTimeoutTimer);
        safeProcessSend(
          JSON.stringify({
            type: "HTTP_REPLY_ABORT",
            requestId: raw.requestId,
            reason: "upstream response error",
          } satisfies HttpReplyAbortType),
          finalizeActiveRequest,
        );
      });

      if (shouldGzip) {
        const gzipStream = zlib.createGzip();
        gzipStream.on("data", (c: Buffer) => {
          if (!aborted) sendChunk(c);
        });
        gzipStream.on("end", finishStream);
        upstreamRes.on("data", (chunk: Buffer) => {
          if (aborted) return;
          resetReadTimeout();
          gzipStream.write(chunk);
        });
        upstreamRes.on("end", () => {
          if (!aborted) gzipStream.end();
        });
      } else {
        upstreamRes.on("data", (chunk: Buffer) => {
          if (aborted) return;
          resetReadTimeout();
          sendChunk(chunk);
        });
        upstreamRes.on("end", finishStream);
      }
    });
    if (raw.requestId) {
      activeRequests.set(raw.requestId, {
        proxyReq,
        clearTimers: () => {
          clearTimeout(connectTimeoutTimer);
          clearTimeout(readTimeoutTimer);
        },
      });
    }
    connectTimeoutTimer = setTimeout(() => {
      proxyReq.destroy();
      recordAndLog(504, 0, workerConfig.server.connectTimeoutMs);
      const reply: WorkerReplyMessageType = {
        requestId: raw.requestId,
        errorCode: "504",
        error: "Connect Timeout",
        data: "",
      };
      sendReplyAndCleanup(raw.requestId, reply);
    }, workerConfig.server.connectTimeoutMs);
    readTimeoutTimer = setTimeout(() => {
      proxyReq.destroy();
      recordAndLog(504, 0, workerConfig.server.readTimeoutMs);
      const reply: WorkerReplyMessageType = {
        requestId: raw.requestId,
        errorCode: "504",
        error: "Read Timeout",
        data: "",
      };
      sendReplyAndCleanup(raw.requestId, reply);
    }, workerConfig.server.readTimeoutMs);
    proxyReq.on("error", (err: any) => {
      logger.error(`Worker:${process.pid}`, `proxyReq error: ${err.message} (${err.code})`);
      clearTimeout(connectTimeoutTimer);
      clearTimeout(readTimeoutTimer);
      const latency = performance.now() - startTime;
      recordAndLog(502, 0, latency);
      const reply: WorkerReplyMessageType = {
        requestId: raw.requestId,
        errorCode: "502",
        error: `Upstream connection failed: ${err.message}`,
        data: "",
      };
      sendReplyAndCleanup(raw.requestId, reply);
    });
    if (msg.body) {
      proxyReq.write(Buffer.from(msg.body, "binary"));
    }
    proxyReq.end();
  } catch (err: any) {
    logger.error(`Worker:${process.pid}`, `Error processing message: ${err.message}`);
  }
});