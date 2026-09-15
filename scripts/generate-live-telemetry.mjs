/**
 * Live Telemetry Traffic Generator for Ninja Reverse Proxy
 * Generates continuous live curves in Grafana:
 * - Steady 200 OK traffic
 * - Active Cache Hits & Cache Offload
 * - Periodic Rate-Limiting Throttling (HTTP 429 curves)
 */

const TARGET = process.env.GATEWAY_URL || "http://127.0.0.1:8080";
const DURATION_SEC = parseInt(process.env.DURATION || "60", 10);

console.log(`Starting Live Telemetry Generator targeting ${TARGET} for ${DURATION_SEC}s...`);

let running = true;
setTimeout(() => { running = false; }, DURATION_SEC * 1000);

let total200 = 0;
let total429 = 0;
let cacheHits = 0;

async function sendRequest(url, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    if (res.status === 200) {
      total200++;
      if (res.headers.get("x-cache") === "HIT") cacheHits++;
    } else if (res.status === 429) {
      total429++;
    }
  } catch {}
}

async function loop() {
  let tick = 0;
  while (running) {
    tick++;
    // 1. Regular traffic (10 reqs/sec)
    const promises = Array.from({ length: 8 }, () => sendRequest(`${TARGET}/api`));

    // 2. Cacheable request
    promises.push(sendRequest(`${TARGET}/api?page=1`));

    // 3. Every 5 ticks, trigger a small rate-limit burst
    if (tick % 5 === 0) {
      for (let b = 0; b < 40; b++) {
        promises.push(sendRequest(`${TARGET}/api`));
      }
    }

    await Promise.all(promises);
    process.stdout.write(`\r[Tick ${tick}] Sent: 200 OK: ${total200} | Cache Hits: ${cacheHits} | Throttled (429): ${total429}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log("\n\nTelemetry generation complete.");
  console.log(`Summary: Total 200 OK: ${total200}, Cache Hits: ${cacheHits}, Throttled (429): ${total429}`);
}

loop();
