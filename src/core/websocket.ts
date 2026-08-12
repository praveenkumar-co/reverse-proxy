import http from "http";
import net from "net";
import tls from "tls";
import { readFileSync } from "fs";
import type { ConfigSchemaType } from "../config/config-schema.js";
import { LoadBalancer } from "../services/load-balancer.js";
import { registry } from "../services/registry.js";
import { logger } from "../middleware/logger.js";

export function handleWebSocketUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  config: ConfigSchemaType,
  lb: LoadBalancer,
) {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const pathRule = config.server.paths.find((p) =>
    url.pathname.startsWith(p.path),
  );

  if (!pathRule) {
    socket.destroy();
    return;
  }

  const clientIP =
    (req.headers["x-forwarded-for"] as string) ??
    socket.remoteAddress ??
    "unknown";

  const HEALTHY_UPSTREAMS_SNAPSHOT = new Set(
    config.server.upstreams.map((u) => u.id),
  );

  const upstreamId = lb.pickFiltered(
    HEALTHY_UPSTREAMS_SNAPSHOT,
    clientIP,
    new Set(),
    req.headers.cookie,
  );
  if (!upstreamId) {
    socket.destroy();
    return;
  }

  const serviceInstance = registry.get(upstreamId);
  if (!serviceInstance) {
    socket.destroy();
    return;
  }

  const upstreamUrl = new URL(serviceInstance.url);
  // Treat both https: and wss: as TLS-backed connections
  const isTls =
    upstreamUrl.protocol === "https:" || upstreamUrl.protocol === "wss:";
  const defaultPort = isTls ? 443 : 80;
  const port = parseInt(upstreamUrl.port || String(defaultPort));

  // Resolve per-upstream TLS config from the static config
  const upstreamStaticConfig = config.server.upstreams.find(
    (u) => u.id === upstreamId,
  );
  const tlsConfig = upstreamStaticConfig?.tls;
  const rejectUnauthorized = tlsConfig?.rejectUnauthorized ?? true;

  if (isTls && !rejectUnauthorized) {
    logger.warn("WebSocket", "TLS certificate verification DISABLED", { upstreamId });
  }

  let caBuffer: Buffer | undefined;
  if (isTls && tlsConfig?.ca) {
    try {
      caBuffer = readFileSync(tlsConfig.ca);
    } catch (err: any) {
      logger.error("WebSocket", `Failed to read CA file: ${err.message}`, { upstreamId, ca: tlsConfig.ca });
    }
  }
  let targetSocket: net.Socket;
  if (isTls) {
    targetSocket = tls.connect(
      {
        host: upstreamUrl.hostname,
        port,
        rejectUnauthorized,
        ...(caBuffer ? { ca: caBuffer } : {}),
      },
      () => {
        sendHandshake(targetSocket, req, head, socket);
      },
    );
  } else {
    targetSocket = net.connect(
      { host: upstreamUrl.hostname, port },
      () => {
        sendHandshake(targetSocket, req, head, socket);
      },
    );
  }

  targetSocket.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    targetSocket.destroy();
  });
}
function sendHandshake(
  targetSocket: net.Socket,
  req: http.IncomingMessage,
  head: Buffer,
  clientSocket: net.Socket,
) {
  let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      val.forEach((v) => {
        rawRequest += `${key}: ${v}\r\n`;
      });
    } else {
      rawRequest += `${key}: ${val}\r\n`;
    }
  }
  rawRequest += "\r\n";
  targetSocket.write(rawRequest);
  if (head && head.length > 0) {
    targetSocket.write(head);
  }

  clientSocket.pipe(targetSocket);
  targetSocket.pipe(clientSocket);
}
