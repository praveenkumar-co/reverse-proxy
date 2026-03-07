import http from 'http';

http.createServer((req,res)=>{
  console.log(`[Node2] Request aaya → ${req.url}`);
  res.writeHead(200);
  res.end("Hello from node2");
}).listen(8002,()=>{
  console.log('Node2 is running 8002');
})