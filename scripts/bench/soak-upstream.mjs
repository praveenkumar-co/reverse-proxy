#!/usr/bin/env node
// One backend implementation reused for every upstream in the soak test (pool-1/2/3, the
// canary candidate, the dynamically-registered upstream, and the flapping upstream) — each
// is its own OS process on its own port; which route points at which port is what gives each
// one its role. Also serves the cacheable/CDC-mapped resource, a WebSocket echo, and an SSE
// stream, so the soak's traffic generator has one backend shape to talk to everywhere.
//
// Usage: node soak-upstream.mjs <port> <id> [--flap]
import http from "node:http";
import crypto from "node:crypto";
import { acceptKeyFor, encodeFrame, createFrameParser } from "./ws-lite.mjs";

const PORT = Number(process.argv[2]);
const ID = process.argv[3] || `upstream-${PORT}`;
const FLAP = process.argv.includes("--flap");
if (!PORT) {
  console.error("soak-upstream.mjs: missing port (argv[2])");
  process.exit(1);
}

const downloadBody = crypto.randomBytes(2 * 1024 * 1024);
let cacheableVersion = 0;
let requestsServed = 0;
let isDown = false;
// Tracks every POST's client-supplied x-request-id so the soak orchestrator can prove "no
// non-idempotent request was retried" — a retried POST (no Idempotency-Key) would show up
// here as a duplicate delivery to this upstream, since a retry sends the same id again.
const postRequestIdCounts = new Map();

const server = http.createServer((req, res) => {
  if (isDown) {
    // A real outage, not a fast-fail: let the client's own timeout do the work, same as an
    // upstream that's hung rather than one that's cleanly refusing connections.
    req.socket.destroy();
    return;
  }
  requestsServed++;
  res.setHeader("x-upstream-id", ID);
  const url = (req.url || "/").split("?")[0];
  const method = req.method || "GET";
  if (method === "POST") {
    const reqId = req.headers["x-request-id"];
    if (reqId) postRequestIdCounts.set(reqId, (postRequestIdCounts.get(reqId) || 0) + 1);
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url === "/stats") {
    const duplicatePostRequestIds = [...postRequestIdCounts.entries()].filter(([, n]) => n > 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: ID, requestsServed, cacheableVersion, duplicatePostRequestIds, uniquePostRequestIds: postRequestIdCounts.size }));
    return;
  }

  // Soak routes (canary/dynamic/flapping/rate-limited/cors) point at this same backend
  // under their own path name — the proxy forwards the full path unchanged (no
  // stripPrefix support in worker.ts), so this backend answers any of them identically.
  if (url === "/echo" || url === "/canary" || url === "/dynamic" || url === "/flapping" || url === "/rate-limited" || url === "/cors") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `SOAK_BACKEND=${ID}; Path=/`,
    });
    res.end(JSON.stringify({ id: ID, path: req.url, method, xff: req.headers["x-forwarded-for"] || null }));
    return;
  }

  if (url === "/sticky") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: ID }));
    return;
  }

  if (url === "/cacheable") {
    cacheableVersion++;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300" });
    res.end(JSON.stringify({ id: ID, version: cacheableVersion }));
    return;
  }

  if ((url === "/upload" || url === "/upload-limited") && method === "POST") {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    req.on("data", (c) => {
      hash.update(c);
      bytes += c.length;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: ID, bytesReceived: bytes, sha256: hash.digest("hex") }));
    });
    return;
  }

  if (url === "/download") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": downloadBody.length });
    res.end(downloadBody);
    return;
  }

  if (url === "/sse") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let seq = 0;
    const interval = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }
      seq++;
      res.write(`data: ${JSON.stringify({ id: ID, seq })}\n\n`);
    }, 2000);
    req.on("close", () => clearInterval(interval));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found", id: ID, url }));
});

server.on("upgrade", (req, socket, head) => {
  if (isDown) {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
  );
  const parse = createFrameParser();
  if (head && head.length > 0) {
    for (const frame of parse(head)) handleWsFrame(socket, frame);
  }
  socket.on("data", (chunk) => {
    for (const frame of parse(chunk)) handleWsFrame(socket, frame);
  });
  socket.on("error", () => {});
});

function handleWsFrame(socket, frame) {
  if (frame.opcode === 0x1) {
    socket.write(encodeFrame(`${ID}:echo:${frame.payload.toString()}`, { opcode: 0x1, masked: false }));
  } else if (frame.opcode === 0x8) {
    try {
      socket.end();
    } catch {}
  } else if (frame.opcode === 0x9) {
    socket.write(encodeFrame(frame.payload, { opcode: 0xa, masked: false }));
  }
}

server.keepAliveTimeout = 60000;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[soak-upstream:${ID}] listening on 127.0.0.1:${PORT} (pid ${process.pid}, flap=${FLAP})`);
});

if (FLAP) {
  const UP_MS = 60000;
  const DOWN_MS = 20000;
  function cycle() {
    isDown = false;
    console.log(`[soak-upstream:${ID}] UP`);
    setTimeout(() => {
      isDown = true;
      console.log(`[soak-upstream:${ID}] DOWN`);
      setTimeout(cycle, DOWN_MS);
    }, UP_MS);
  }
  cycle();
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
