#!/usr/bin/env node
// Real HTTP upstream used by scripts/bench-vs-nginx.mjs and scripts/soak.mjs — a standalone
// OS process (never imported into the benchmark/load-generator process). Serves:
//   /small  -> a fixed 1KB JSON body
//   /large  -> a fixed 1MB binary body
//   /health -> 200 OK, for health checks
// Port and payload sizes come from argv / env so one script covers every bench scenario.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || process.env.UPSTREAM_PORT || 0);
if (!PORT) {
  console.error("upstream-server.mjs: missing port (argv[2] or UPSTREAM_PORT)");
  process.exit(1);
}

const smallBody = Buffer.from(JSON.stringify({ ok: true, size: "small", payload: "x".repeat(900) }));
const largeBody = crypto.randomBytes(1024 * 1024);

let requestsServed = 0;

const server = http.createServer((req, res) => {
  requestsServed++;
  const url = (req.url || "/").split("?")[0];
  if (url === "/small") {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": smallBody.length });
    res.end(smallBody);
  } else if (url === "/large") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": largeBody.length });
    res.end(largeBody);
  } else if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  } else if (url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ requestsServed }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.keepAliveTimeout = 60000;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[upstream-server] listening on 127.0.0.1:${PORT} (pid ${process.pid})`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
