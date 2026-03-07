import http from "http";
import https from 'https';
import { readFileSync } from 'fs';
import type { ConfigSchemaType } from "./config-schema.js";
import cluster, { Worker } from "node:cluster";
import { rootConfigSchema } from "./config-schema.js";
import type { WorkerMessageType } from "./server-schema.js";
import { workerMessageSchema } from "./server-schema.js";
import type { WorkerReplyMessageType } from "./server-schema.js";
import { workerMessageReplySchema } from "./server-schema.js";
import { initialHealthCheck, startHealthChecks } from "./health.js"; 
import {RateLimiter} from './rate-limiter.js';

interface createServerConfig {
  port: number;
  workerCount: number;
  config: ConfigSchemaType;
}
export async function createServer(config: createServerConfig) {
  const { port, workerCount } = config; 
  const WORKER_POOL: Worker[] = [];
  const HEALTHY_UPSTREAMS: Set<string> = new Set(
    config.config.server.upstreams.map((e) => e.id)
  );
  // map of ratelimiters for every
  if(cluster.isPrimary){
    // these files are private to user  
    const sslOptions = { 
      key : readFileSync('key.pem'),
      cert : readFileSync('cert.pem')
    };
    const rateLimiters = new Map<string,RateLimiter>();
    // setting new ratelimiter for incoming new request 
  config.config.server.paths.forEach((path) =>{
     if(path.rateLimit){
       rateLimiters.set(path.path,new RateLimiter({
        windowMs: path.rateLimit.windowMs,
        maxRequests : path.rateLimit.maxRequests  
       }));
      }
  })
    console.log("Master is running up");
      // Event registration 
    cluster.on("online", (worker) => {
      console.log(`${worker.process.pid} is now online`);
    });
    cluster.on("exit", (worker) => {
      // removing dead worker to stop master processing crash 
      console.log(`[Master] Worker PID ${worker.process.pid} died`);
      const deadWorkerIndex = WORKER_POOL.indexOf(worker);
      if (deadWorkerIndex !== -1) {
        WORKER_POOL.splice(deadWorkerIndex, 1);
        console.log(`[Master] Dead worker removed from pool`);
      }
      // Replacement worker !
      const newWorker = cluster.fork({
        APP_CONFIG: JSON.stringify(config.config),
      });
      WORKER_POOL.push(newWorker);
    });
    // Fork workers
    for (let i = 0; i < workerCount; i++) {
      const worker = cluster.fork({
        APP_CONFIG: JSON.stringify(config.config),
      });
      WORKER_POOL.push(worker);
    }
     //  round robin Algorith
    let currentWorkerIndex = 0;
      // removing server and replacing to httpServer 
    const httpServer = http.createServer((req, res) => {
      const httpsUrl = `https://${req.headers.host?.replace('8080', '8443')}${req.url}`;
      res.writeHead(301,{
        'Location' : httpsUrl
      });
      res.end();
    }); 
    // making https server between client and reverse proxy 
    const httpsServer = https.createServer(sslOptions,(req,res)=>{
      const clientIP = req.socket.remoteAddress ?? 'unknown';
      const routeLimiter = rateLimiters.get(req.url ?? "/");
      // is client IP allowed
      if(routeLimiter && !routeLimiter.isAllowed(clientIP)){
           res.writeHead(429, {
            'Content-Type': 'application/json', 
            'Retry-After': Math.ceil((routeLimiter.getResetTime(clientIP) - Date.now()) / 1000).toString(),
            'X-RateLimit-Remaining': '0',
        });
        res.end(JSON.stringify({
          error : 'Too Many Requests!',
           retryAfter: `${Math.ceil((routeLimiter.getResetTime(clientIP) - Date.now()) / 1000)} seconds try later!`
        }));
        return ; // stop right away  
      }
        if(routeLimiter){
             res.setHeader('X-RateLimit-Remaining', 
            routeLimiter.getRemainingRequests(clientIP).toString()
        );
        }
        let body = '';
        req.on('data',(chunk)=>{
          body += chunk;
        });
        req.on('end',()=>{
        // choosing random worker from pool
      const worker = WORKER_POOL[currentWorkerIndex % WORKER_POOL.length];
      currentWorkerIndex++;
      if (!worker) {
        res.writeHead(500);
          res.end("No workers available");
          return;
      }
        const payload: WorkerMessageType = {
          requestType: (req.method ?? 'GET') as 'GET' || 'POST' || 'PUT' || 'PATCH' || 'DELETE' ,
          headers: req.headers,
          body: body || null ,
          url: `${req.url}`,
        };
        worker.send(JSON.stringify(payload));
        worker.once("message", async (workerReply: string) => {
          const reply = await workerMessageReplySchema.parseAsync(
            JSON.parse(workerReply)
          );
        if (reply.errorCode) {
          res.writeHead(parseInt(reply.errorCode));
          res.end(reply.error);
        } else {
          res.writeHead(200);
          res.end(reply.data);
        }
      });
    });
  });
    // intial health check 
    await initialHealthCheck(config.config.server.upstreams, HEALTHY_UPSTREAMS);
     httpServer.listen(port, () => {
       console.log(`HTTP listening on PORT ${port} (redirects to HTTPS)`);
    });
    // starting the HTTPS connection 
    httpsServer.listen(8443, () => {
      console.log(`HTTPS on PORT 8443`);
      startHealthChecks(config.config.server.upstreams, HEALTHY_UPSTREAMS);
    });
  }
  else {
    // if chance of worker instead of master 
    console.log(`Worker ${process.pid} spinned UP`);
    // process.env.APP_CONFIG refer 
    const workerConfig = await rootConfigSchema.parseAsync(
      JSON.parse(process.env.APP_CONFIG!)
    );
    process.on("message", async (message: string) => {
      const messageValidated = await workerMessageSchema.parseAsync(
        JSON.parse(message)
      );
      const requestUrl = messageValidated.url;
      const rule = workerConfig.server.paths.find((e) => e.path === requestUrl);
      if (!rule) {
        const reply: WorkerReplyMessageType = {
          errorCode: "404",
          error: "Rule not found",
          data: "",
        };
        if (process.send) process.send(JSON.stringify(reply));
        return;
      }
      //Healthy upstream ! sending to backend server  
      const upstreamID = rule.upstream.find((id) => HEALTHY_UPSTREAMS.has(id));
      if (!upstreamID) {
        const reply: WorkerReplyMessageType = {
          errorCode: "500",
          error: "No healthy upstreams available!",
          data: "",
        };
        if (process.send) process.send(JSON.stringify(reply));
        return;
      }
      // after recieving the correct details from reverse Porxy 
      const upstream = workerConfig.server.upstreams.find(
        (e) => e.id === upstreamID
      );
      if (!upstream) {
        const reply: WorkerReplyMessageType = {
          errorCode: "500",
          error: "Upstream not found",
          data: "",
        };
        if (process.send) process.send(JSON.stringify(reply));
        return;
      }
      const upstreamUrl = new URL(upstream.url);
      const proxyReq = http.request(
        {
          host: upstreamUrl.hostname,
          port: upstreamUrl.port,
          path: requestUrl,
          method: messageValidated.requestType, // all type http request
          headers: {
            ...messageValidated.headers,
            "X-Forwarded-For": "127.0.0.1",
            "X-Real-IP": "127.0.0.1",
            "X-Proxy-By": "Ninja-Reverse-Proxy",
            ...(messageValidated.body && {
               'Content-Length' : Buffer.byteLength(messageValidated.body).toString()
            })
          },
        },  
        (upstreamRes) => {
          let body = "";
          const timeout = setTimeout(() => {
            const reply: WorkerReplyMessageType = {
              errorCode: "500",
              error: "Gateway Timeout",
              data: "",
            };
            if (process.send) process.send(JSON.stringify(reply));
            proxyReq.destroy();
          }, 5000);

          upstreamRes.on("data", (chunk) => {
            body += chunk;
          });
          upstreamRes.on("end", () => {
            clearTimeout(timeout);
            const reply: WorkerReplyMessageType = {
              data: body,
              error: "",
            };
            if (process.send) process.send(JSON.stringify(reply));
          });
        });
        if(messageValidated.body){
          proxyReq.write(messageValidated.body);
        }
      proxyReq.end();
    });
  }
}
