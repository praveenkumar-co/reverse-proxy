import http from 'http';

export function createMockServer(port: number, statusCode = 200, body = 'OK'): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  server.listen(port);
  return server;
}
