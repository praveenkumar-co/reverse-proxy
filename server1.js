import http from "http";

// ── Environment variables ──
const PORT = parseInt(process.env.SERVER_PORT ?? "8001");
const SERVER_ID = process.env.SERVER_ID ?? "node1";
const PROXY_HOST = process.env.PROXY_HOST ?? "proxy";
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "8080");

// ── Register ──
function registerSelf() {
  const body = JSON.stringify({
    id: SERVER_ID,
    url: `http://${SERVER_ID}:${PORT}`,
  });
  const req = http.request(
    {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: "/__registry/register",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    },
    (res) => {
      console.log(`[${SERVER_ID}] Registered! Status: ${res.statusCode}`);
    }
  );
  req.on("error", () => setTimeout(registerSelf, 3000));
  req.write(body);
  req.end();
}

// ── Heartbeat ──
function sendHeartbeat() {
  const req = http.request({
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: `/__registry/heartbeat/${SERVER_ID}`,
    method: "PUT",
    rejectUnauthorized: false,
  });
  req.on("error", () => {});
  req.end();
}

// ── Deregister ──
function deregisterSelf() {
  const req = http.request({
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: `/__registry/deregister/${SERVER_ID}`,
    method: "DELETE",
    rejectUnauthorized: false,
  });
  req.on("error", () => {});
  req.end();
}

// ── HTTP Server ──
http
  .createServer((req, res) => {
    console.log(`[${SERVER_ID}] ${req.method} → ${req.url}`);
    if (req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "UP", id: SERVER_ID }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200);
          res.end(`Hello from ${SERVER_ID} (port ${PORT}) — GET`);
      } else if (req.method === "POST") {
        res.writeHead(201);
          res.end(`${SERVER_ID} POST received: ${body}`);
      } else if (req.method === "PUT") {
        res.writeHead(200);
        res.end(`${SERVER_ID} PUT received: ${body}`);
      } else if (req.method === "PATCH") {
        res.writeHead(200);
        res.end(`${SERVER_ID} PATCH received: ${body}`);
      } else if (req.method === "DELETE") {
        res.writeHead(200);
        res.end(`${SERVER_ID} DELETE done!`);
      }
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`[${SERVER_ID}] Running on port ${PORT}`);
    setTimeout(registerSelf, 5000);
    setInterval(sendHeartbeat, 10_000);
  });

// ── Graceful shutdown ──
process.on("SIGTERM", () => {
  deregisterSelf();
  setTimeout(() => process.exit(0), 1000);
});
process.on("SIGINT", () => {
  deregisterSelf();
  setTimeout(() => process.exit(0), 1000);
});
