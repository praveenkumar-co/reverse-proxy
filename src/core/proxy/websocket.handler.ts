import net from "net";
import tls from "tls";
import { readFileSync } from "fs";
import { logger } from "../../observability/logger/logger.js";

export interface WebSocketRequestFields {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | string[] | undefined>;
}

export function tunnelWebSocket(
  clientSocket: net.Socket,
  upstreamUrlStr: string,
  reqFields: WebSocketRequestFields,
  head: Buffer,
  tlsConfig?: { rejectUnauthorized?: boolean; ca?: string | undefined },
): void {
  const upstreamUrl = new URL(upstreamUrlStr);
  const isTls = upstreamUrl.protocol === "https:" || upstreamUrl.protocol === "wss:";
  const defaultPort = isTls ? 443 : 80;
  const port = parseInt(upstreamUrl.port || String(defaultPort), 10);
  const rejectUnauthorized = tlsConfig?.rejectUnauthorized ?? true;

  if (isTls && !rejectUnauthorized) {
    logger.warn("WebSocket", "TLS certificate verification is DISABLED", { upstreamUrl: upstreamUrlStr });
  }
  let caBuffer: Buffer | undefined;
  if (isTls && tlsConfig?.ca) {
    try {
      caBuffer = readFileSync(tlsConfig.ca);
    } catch (err: any) {
      logger.error("WebSocket", `Failed to read CA file: ${err.message}`, { ca: tlsConfig.ca });
    }
  }

  let targetSocket: net.Socket;
  const onConnect = () => {
    let rawRequest = `${reqFields.method} ${reqFields.url} HTTP/${reqFields.httpVersion}\r\n`;
    for (const [key, val] of Object.entries(reqFields.headers)) {
      if (Array.isArray(val)) {
        val.forEach((v) => {
          rawRequest += `${key}: ${v}\r\n`;
        });
      } else if (val !== undefined) {
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
  };

  if (isTls) {
    targetSocket = tls.connect(
      {
        host: upstreamUrl.hostname,
        port,
        rejectUnauthorized,
        ...(caBuffer ? { ca: caBuffer } : {}),
      },
      onConnect,
    );
  } else {
    targetSocket = net.connect(
      { host: upstreamUrl.hostname, port },
      onConnect,
    );
  }

  targetSocket.on("error", (err) => {
    logger.error("WebSocket", `Upstream target socket error: ${err.message}`);
    clientSocket.destroy();
  });
  clientSocket.on("error", (err) => {
    logger.error("WebSocket", `Client socket error: ${err.message}`);
    targetSocket.destroy();
  });
}
