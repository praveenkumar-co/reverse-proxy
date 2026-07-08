
import http from "http";
import express from "express";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.SERVER_PORT ?? "3001");
const SERVER_ID = process.env.SERVER_ID ?? "express-backend";
const PROXY_HOST = process.env.PROXY_HOST ?? "localhost";
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "8080");

app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", id: SERVER_ID });
});

app.get("/", (req, res) => {
  res.json({
    message: `Hello from ${SERVER_ID}`,
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/users", (req, res) => {
  res.json({
    users: [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ],
    servedBy: SERVER_ID,
  });
});

app.post("/api/users", (req, res) => {
  const { name } = req.body;
  res.status(201).json({ message: `User '${name}' created`, servedBy: SERVER_ID });
});

function registerSelf() {
  const body = JSON.stringify({
    id: SERVER_ID,
    url: `http://${process.env.REGISTER_HOST ?? SERVER_ID}:${PORT}`,
    metadata: { type: "express", startedAt: new Date().toISOString() },
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
    },
    (res) => {
      console.log(`[${SERVER_ID}] Registered with proxy — status: ${res.statusCode}`);
    }
  );
  req.on("error", () => {
    console.log(`[${SERVER_ID}] Registration failed — retrying in 3s`);
    setTimeout(registerSelf, 3000);
  });
  req.write(body);
  req.end();
}

function sendHeartbeat() {
  const req = http.request({
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: `/__registry/heartbeat/${SERVER_ID}`,
    method: "PUT",
  });
  req.on("error", () => {});
  req.end();
}

function deregisterSelf() {
  const req = http.request({
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: `/__registry/deregister/${SERVER_ID}`,
    method: "DELETE",
  });
  req.on("error", () => {});
  req.end();
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[${SERVER_ID}] Running on port ${PORT}`);
  setTimeout(registerSelf, 5000);
  setInterval(sendHeartbeat, 10_000);
});

process.on("SIGTERM", () => {
  console.log(`[${SERVER_ID}] Shutting down...`);
  deregisterSelf();
  setTimeout(() => process.exit(0), 1000);
});
process.on("SIGINT", () => {
  deregisterSelf();
  setTimeout(() => process.exit(0), 1000);
});
