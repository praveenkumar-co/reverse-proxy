import http from "http";
import https from "https";
import { readFileSync } from "fs";
import zlib from "zlib";
import { rootConfigSchema } from "../config/config-schema.js";
import {
  workerMessageSchema,
  type WorkerReplyMessageType,
} from "../config/server-schema.js";
import { logger } from "../middleware/logger.js";
import { tunnelWebSocket } from "./websocket.js";
import net from "net";
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
const workerConfig = await rootConfigSchema.parseAsync(
  JSON.parse(process.env["APP_CONFIG"]!),
);

process.on("message", (msgStr: string) => {
  try {
    const msg = JSON.parse(msgStr);
    if (msg.type === "GRACEFUL_SHUTDOWN") {
      logger.info(`Worker:${process.pid}`, "Gracefully draining connections");
    }
  } catch {
    // ignore parse errors on non-JSON messages
  }
});

process.on("message", async (msgStr: string, handle?: any) => {
  try {
    const payload = JSON.parse(msgStr);
    if (payload.type === "WEBSOCKET_UPGRADE" && handle) {
      const clientSocket = handle as net.Socket;
      const head = Buffer.from(payload.head, "base64");

      // Resolve the TLS config for this upstream
      const upstreamStaticConfig = workerConfig.server.upstreams.find(
        (u) => u.id === payload.upstreamId,
      );
      const tlsConfig = upstreamStaticConfig?.tls;

      logger.info(`Worker:${process.pid}`, "Received WebSocket socket handle handoff from master", {
        url: payload.reqFields.url,
        upstreamId: payload.upstreamId,
      });

      tunnelWebSocket(clientSocket, payload.upstreamUrl, payload.reqFields, head, tlsConfig);
    }
  } catch (err: any) {
    logger.error(`Worker:${process.pid}`, `Websocket handoff failed: ${err.message}`);
  }
});

process.on("message", async (message: string) => {
  let msg;
  try {
    msg = await workerMessageSchema.parseAsync(JSON.parse(message));
  } catch {
    // Not a request message (e.g. GRACEFUL_SHUTDOWN already handled above)
    return;
  }

  const raw = JSON.parse(message) as {
    upstreamId?: string;
    upstreamUrl?: string;
    requestId?: string;
  };
  const upstreamUrl: string | undefined = raw.upstreamUrl;
  const requestUrl = msg.url;

  const rule = workerConfig.server.paths.find((e) =>
    requestUrl.startsWith(e.path),
  );

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
    const upstream = workerConfig.server.upstreams.find(
      (e) => e.id === rule.upstream[0],
    );
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
    (u) => u.url === finalUpstreamUrl.toString() || new URL(u.url).origin === finalUpstreamUrl.origin,
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
      logger.error(`Worker:${process.pid}`, `Failed to read CA file: ${err.message}`, { ca: tlsConfig.ca });
    }
  }

  let connectTimeoutTimer: NodeJS.Timeout;
  let readTimeoutTimer: NodeJS.Timeout;

  const requestOptions: http.RequestOptions = {
    host: finalUpstreamUrl.hostname,
    port: finalUpstreamUrl.port || (isHttps ? "443" : "80"),
    path: requestUrl,
    method: msg.requestType,
    agent,
    headers: {
      ...msg.headers,
      "X-Forwarded-For": msg.headers["x-forwarded-for"] || "unknown",
      "X-Real-IP": "127.0.0.1",
      "X-Proxy-By": "Ninja-Reverse-Proxy",
      ...(msg.body && {
        "Content-Length": Buffer.byteLength(msg.body).toString(),
      }),
    },
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

      const sendReply = (rawBody: Buffer) => {
        if (
          workerConfig.server.compression &&
          isCompressible &&
          acceptEncoding.includes("gzip")
        ) {
          zlib.gzip(rawBody, (err, compressed) => {
            const reply = {
              requestId: raw.requestId,
              data: err
                ? rawBody.toString("utf8")
                : compressed.toString("base64"),
              isCompressed: !err,
              encoding: err ? undefined : "gzip",
              statusCode: upstreamRes.statusCode ?? 200,
              headers: err
                ? forwardHeaders
                : { ...forwardHeaders, "content-encoding": "gzip" },
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
            // Decompression failed — send raw bytes as base64 with original headers
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
});
