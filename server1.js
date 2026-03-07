import http from 'http';

http.createServer((req, res) => {
    console.log(`[Node1] ${req.method} → ${req.url}`);

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        if(req.method === 'GET') {
            res.writeHead(200);
            res.end('Hello from Node1!  GET');

        } else if(req.method === 'POST') {
            res.writeHead(201);
            res.end(`Node1 POST received: ${body}`);

        } else if(req.method === 'PUT') {
            res.writeHead(200);
            res.end(`Node1 PUT received: ${body}`);

        } else if(req.method === 'PATCH') {
            res.writeHead(200);
            res.end(`Node1 PATCH received: ${body}`);

        } else if(req.method === 'DELETE') {
            res.writeHead(200);
            res.end(`Node1 DELETE done!`);
        }
    });
}).listen(8001, () => {
    console.log('Node1 running on port 8001');
});