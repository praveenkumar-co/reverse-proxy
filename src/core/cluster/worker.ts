import http from "http";
import https from "https";
import { readFileSync } from "fs";
import zlib from "zlib";
import { rootConfigSchema } from "../../config/schemas/server.schema.js";
import { workerMessageSchema, type WorkerReplyMessageType } from "./ipc.protocol.js";
import { logger } from "../../observability/logger/logger.js";
import { tunnelWebSocket } from "../proxy/websocket.handler.js";
import net from "net";
import { MetricsRegistry } from "../../observability/metrics/prometheus.exporter.js";
import { writeAccessLog } from "../../observability/logger/logger.js";
import { tenantLogStreamer } from "../../observability/logger/tenant-log.streamer.js";

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 256,
  maxFreeSockets: 32,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 256,
  maxFreeSockets: 32,
});
const workerConfig = await rootConfigSchema.parseAsync(JSON.parse(process.env["APP_CONFIG"]!));
const healthyUpstreams = new Set<string>(workerConfig.server.upstreams.map((u) => u.id));
const metricsRegistry = new MetricsRegistry(healthyUpstreams);
if (workerConfig.observability?.tenantDelivery?.mode === "webhook") {
  tenantLogStreamer.configure(workerConfig.observability.tenantDelivery.exportEndpoints);
}
process.on("message", async (rawMsg: any, handle?: any) => {
  try {
    const parsed = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
    if (!parsed) {
      return;
    }

    if (parsed.type === "GRACEFUL_SHUTDOWN") {
      logger.info(`Worker:${process.pid}`, "Gracefully draining connections");
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
    const upstreamUrl: string | undefined = raw.upstreamUrl;
    const requestUrl = msg.url;
    const startTime = performance.now();
    const rule = workerConfig.server.paths.find((e) => requestUrl.startsWith(e.path));
    if (!rule) {
      const reply: WorkerReplyMessageType = {
        requestId: raw.requestId,
        errorCode: "404",
        error: "Route not found",
        data: "",
      };
      if (process.send) process.send(JSON.stringify(reply));
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
        if (process.send) process.send(JSON.stringify(reply));
        return;
      }
      finalUpstreamUrl = new URL(upstream.url);
    }
    const isHttps = finalUpstreamUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
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
        msg.url,
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
      forwardHeaders["content-length"] = Buffer.byteLength(msg.body).toString();
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
    const proxyReq = transport.request(requestOptions, (upstreamRes) => {
      clearTimeout(connectTimeoutTimer);
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      upstreamRes.on("end", () => {
        clearTimeout(readTimeoutTimer);
        const bodyBuffer = Buffer.concat(chunks);
        const acceptEncoding = msg.headers["accept-encoding"] || "";
        const contentType = upstreamRes.headers["content-type"] || "";
        const isCompressible = /json|text|javascript|css/.test(contentType);
        const upstreamEncoding = upstreamRes.headers["content-encoding"];
        const forwardHeaders = { ...upstreamRes.headers };
        delete forwardHeaders["content-encoding"];
        const latency = performance.now() - startTime;
        recordAndLog(upstreamRes.statusCode ?? 200, bodyBuffer.length, latency);
        const sendReply = (rawBody: Buffer) => {
          if (
            workerConfig.server.compression &&
            isCompressible &&
            acceptEncoding.includes("gzip")
          ) {
            zlib.gzip(rawBody, (err, compressed) => {
              const reply = {
                requestId: raw.requestId,
                data: err ? rawBody.toString("utf8") : compressed.toString("base64"),
                isCompressed: !err,
                encoding: err ? undefined : "gzip",
                statusCode: upstreamRes.statusCode ?? 200,
                headers: err ? forwardHeaders : { ...forwardHeaders, "content-encoding": "gzip" },
              };
              if (process.send) process.send(JSON.stringify(reply));
            });
          } else {
            const reply: WorkerReplyMessageType = {
              requestId: raw.requestId,
              data: rawBody.toString("utf8"),
              statusCode: upstreamRes.statusCode ?? 200,
              headers: forwardHeaders,
            };
            if (process.send) process.send(JSON.stringify(reply));
          }
        };
        if (upstreamEncoding === "gzip") {
          zlib.gunzip(bodyBuffer, (err, decompressed) => {
            if (err) {
              const reply: WorkerReplyMessageType = {
                requestId: raw.requestId,
                data: bodyBuffer.toString("base64"),
                isCompressed: true,
                encoding: "gzip",
                statusCode: upstreamRes.statusCode ?? 200,
                headers: upstreamRes.headers,
              };
              if (process.send) process.send(JSON.stringify(reply));
            } else {
              sendReply(decompressed);
            }
          });
        } else {
          sendReply(bodyBuffer);
        }
      });
    });
    connectTimeoutTimer = setTimeout(() => {
      proxyReq.destroy();
      recordAndLog(504, 0, workerConfig.server.connectTimeoutMs);
      const reply: WorkerReplyMessageType = {
        requestId: raw.requestId,
        errorCode: "504",
        error: "Connect Timeout",
        data: "",
      };
      if (process.send) process.send(JSON.stringify(reply));
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
      if (process.send) process.send(JSON.stringify(reply));
    }, workerConfig.server.readTimeoutMs);
    proxyReq.on("error", (err) => {
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
      if (process.send) process.send(JSON.stringify(reply));
    });
    if (msg.body) {
      proxyReq.write(Buffer.from(msg.body, "binary"));
    }
    proxyReq.end();
  } catch (err: any) {
    logger.error(`Worker:${process.pid}`, `Error processing message: ${err.message}`);
  }
});