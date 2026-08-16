import https from 'https';

async function benchmark(url: string, requests: number, concurrency: number) {
  console.log(`Benchmarking ${url}: ${requests} requests, concurrency ${concurrency}`);
  const agent = new https.Agent({ rejectUnauthorized: false });
  let completed = 0;
  const start = Date.now();

  const worker = () => new Promise<void>(resolve => {
    https.get(url, { agent }, (res) => {
      res.resume();
      res.on('end', () => { completed++; resolve(); });
    }).on('error', () => { completed++; resolve(); });
  });

  const batches = Math.ceil(requests / concurrency);
  for (let i = 0; i < batches; i++) {
    await Promise.all(Array.from({ length: Math.min(concurrency, requests - i * concurrency) }, worker));
  }

  const elapsed = Date.now() - start;
  console.log(`Done: ${completed} requests in ${elapsed}ms (${Math.round(completed / elapsed * 1000)} req/s)`);
}

benchmark('https://localhost:8443/', 1000, 10).catch(console.error);
