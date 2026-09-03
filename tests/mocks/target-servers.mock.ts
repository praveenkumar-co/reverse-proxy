import http from 'http';

export async function createMockServer(port = 0, statusCode = 200, body = 'OK'): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const assignedPort = (server.address() as any).port;
  return { server, port: assignedPort };
}
