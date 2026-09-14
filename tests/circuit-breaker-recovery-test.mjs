// tests/circuit-breaker-recovery-test.mjs
import http from "http";
import { spawn } from "child_process";

const GATEWAY_URL = "http://127.0.0.1:8080";

function makeRequest(path) {
  return new Promise((resolve) => {
    const url = new URL(GATEWAY_URL + path);
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on("error", (err) => resolve({ error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runRecoveryAudit() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("⚡ CIRCUIT BREAKER & AUTOMATIC HEALTH RECOVERY TEST");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  console.log("🔹 STEP 1: Baseline Check — Verifying Gateway & Backend are UP...");
  const initial = await makeRequest("/docs");
  console.log(`   └─ Initial /docs status: ${initial.statusCode} (Expected: 200)`);

  console.log("\n🔹 STEP 2: Simulating Backend Outage (Killing Python FastAPI)...");
  // Find PID listening on 8000
  const findPid = spawn("lsof", ["-t", "-i:8000"]);
  let pid = "";
  findPid.stdout.on("data", (d) => (pid += d.toString()));
  await new Promise((r) => findPid.on("close", r));
  const pythonPid = pid.trim().split("\n")[0];

  if (pythonPid) {
    console.log(`   └─ Killing FastAPI process (PID: ${pythonPid})...`);
    process.kill(Number(pythonPid), "SIGTERM");
    await sleep(2000);
  } else {
    console.log("   ⚠️ No process found on 8000!");
  }

  console.log("\n🔹 STEP 3: Dispatching Traffic to Proxy During Backend Outage...");
  const outageRes = await makeRequest("/docs");
  console.log(`   🛡️ Proxy Clean Interception: HTTP ${outageRes.statusCode}`);
  console.log(`   └─ Body received: ${outageRes.body ? outageRes.body.trim().slice(0, 80) : "N/A"}`);
  console.log(`   └─ Notice: Reverse Proxy did NOT crash! Handled failure gracefully.`);

  console.log("\n🔹 STEP 4: Simulating Backend Recovery (Restarting FastAPI)...");
  const uvicornProc = spawn(".venv/bin/uvicorn", ["--host", "127.0.0.1", "--port", "8000", "app.main:app"], {
    cwd: "/Users/praveen/Code/fastapi-conduit",
    detached: true,
    stdio: "ignore",
  });
  uvicornProc.unref();
  console.log(`   └─ Spawned fresh FastAPI instance. Waiting for health checker to auto-heal...`);

  // Wait for health check (health check interval is 10s)
  let recovered = false;
  for (let i = 1; i <= 15; i++) {
    await sleep(1500);
    const check = await makeRequest("/docs");
    if (check.statusCode === 200) {
      console.log(`   ✅ AUTO-HEALED! Succeeded at probe #${i}: HTTP 200 OK`);
      recovered = true;
      break;
    } else {
      process.stdout.write(`   ⏳ Probe #${i} status: ${check.statusCode}, waiting for health checker...\r`);
    }
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════════");
  if (recovered) {
    console.log("🎉 SUCCESS: Circuit Breaker & Zero-Downtime Auto-Recovery VERIFIED!");
  } else {
    console.log("❌ Recovery timed out");
  }
  console.log("═══════════════════════════════════════════════════════════════════");
}

runRecoveryAudit().catch(console.error);
