import http from 'http';
import https from 'https';

export const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 256,
  maxFreeSockets: 32,
});

export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 256,
  maxFreeSockets: 32,
});

export function getAgent(isHttps: boolean): http.Agent | https.Agent {
  return isHttps ? httpsAgent : httpAgent;
}
