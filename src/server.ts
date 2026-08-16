import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import type { RootConfigType } from './config/schemas/server.schema.js';

export function createHttpServer(handler: http.RequestListener): http.Server {
  return http.createServer(handler);
}

export function createHttpsServer(config: RootConfigType, handler: http.RequestListener): https.Server {
  const sslOptions = {
    key: readFileSync('key.pem'),
    cert: readFileSync('cert.pem'),
  };
  return https.createServer(sslOptions, handler);
}
