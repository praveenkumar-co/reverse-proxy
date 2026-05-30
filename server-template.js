import http from "http";

const PORT = parseInt(process.env.SERVER_PORT ?? "8003");
const SERVER_ID = process.env.SERVER_ID ?? `auto-node-${PORT}`;
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "8080");
const PROXY_HOST = process.env.PROXY_HOST ?? "localhost";

const SERVER_URL = `http://${process.env.PROXY_HOST ? SERVER_ID : 'localhost'}:${PORT}`;

function registerSelf() {
  const body = JSON.stringify({
    id: SERVER_ID,
    url: SERVER_URL,
    metadata: {
      type: "auto-scaled",
      startedAt: new Date().toISOString(),
    },
  });
  const options = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: "/__registry/register",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    rejectUnauthorized: false,
  };
  const req = http.request(options, (res) => {
    console.log(`[${SERVER_ID}] Registered! Status: ${res.statusCode}`);
  });
  req.on("error", (err) => {
    console.log(
      `[${SERVER_ID}] Register failed: ${err.message} — retrying in 3s`
    );
    setTimeout(registerSelf, 3000);
  });
  req.write(body);
  req.end();
}

function sendHeartbeat() {
  const options = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: `/__registry/heartbeat/${SERVER_ID}`,
    method: "PUT",
    rejectUnauthorized: false,
  };
  const req = http.request(options);
  req.on("error", () => {});
  req.end();
}
function deregisterSelf() {
  const options = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: `/__registry/deregister/${SERVER_ID}`,
    method: "DELETE",
    rejectUnauthorized: false,
  };
  const req = http.request(options, () => {
    console.log(`[${SERVER_ID}] Deregistered successfully`);
  });
  req.on("error", () => {});
  req.end();
}

const server = http.createServer((req, res) => {
  console.log(`[${SERVER_ID}] ${req.method} → ${req.url}`);

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("OK");
      return;
    }

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
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[${SERVER_ID}] Running on port ${PORT}`);
  setTimeout(registerSelf, 5000);
  setInterval(sendHeartbeat, 10_000);
});
//GraceFul shutdown  :
process.on("SIGTERM", () => {
  console.log(`[${SERVER_ID}] Shutting down...`);
  deregisterSelf();
  setTimeout(() => {
    server.close(() => process.exit(0));
  });
});
process.on("SIGINT", () => {
  deregisterSelf();
  setTimeout(() => {
    server.close(() => process.exit(0));
  }, 1000);
});
