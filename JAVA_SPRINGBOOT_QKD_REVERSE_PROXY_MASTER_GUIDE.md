# ⚛️ Java Spring Boot QKD Simulation & Ninja Reverse Proxy: Master Unified Guide & Audit

## 📌 Executive Summary
* **Target Reverse Proxy**: `ninja-reverse-proxy` (v1.1.0)
* **Architecture**: Multi-Worker Reverse Proxy Cluster with Power of Two Choices (P2C) Load Balancing, Adaptive Circuit Breaking, Token Bucket Rate Limiting, and IPC Prometheus Exporter
* **Upstream Backend**: Java Spring Boot 3.3.5 / OpenJDK 21 (Temurin) QKD (Quantum Key Distribution) Simulator (`http://127.0.0.1:8081`)
* **Upstream Repository**: `https://github.com/sshekhar-04/QKD-simulation`
* **Isolated Configuration Path**: `/Users/praveen/Code/QKD-simulation/config.yaml`
* **Automated Verification**: **10 / 10 Tests Passed (100% SUCCESS)**
* **Peak Gateway Throughput**: **19,023 req/sec** (Autocannon Load Bench)
* **Average Latency**: **0.78 ms - 7.62 ms**
* **Prometheus Upstream Status**: `ninja_upstream_status{upstream_id="qkd-java-service"} 1` (**UP**)
* **Result Artifacts Directory**: `/Users/praveen/Code/Backend/reverse-proxy/result/java-spring-boot-qkd/`

---

## 🏛️ Architecture & Port Mapping

```
[ Outside World / Client / Microservice ]
                │
                ▼ (Port 8080)
┌─────────────────────────────────────────────────────────────┐
│                 NINJA REVERSE PROXY GATEWAY                 │
│  - Master-Worker IPC Cluster (2 Workers)                    │
│  - Token Bucket Rate Limiter (500 req/min)                  │
│  - Distributed Tracing (X-Trace-Id, X-Upstream-Id)          │
│  - Power-of-Two Load Balancing                              │
│  - Prometheus OpenMetrics Exporter (/:8080/metrics)         │
│  - Health Probing: /api/qkd/encrypt?message=healthcheck     │
│  - Routes: /api/qkd, / (fallback)                           │
└──────────────────────────────┬──────────────────────────────┘
                               │ (Internal HTTP/1.1 Keep-Alive)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             JAVA SPRING BOOT QKD SIMULATOR                  │
│  - Container: qkd-simulator (Docker)                        │
│  - Port: 127.0.0.1:8081                                     │
│  - Runtime: OpenJDK 21 (Eclipse Temurin JRE)                │
│  - Framework: Spring Boot 3.3.5 (Apache Tomcat 10.1.31)     │
│  - Components:                                              │
│    • QkdEngine: BB84 Photon Polarization Simulation         │
│    • Eavesdropper Detection: Eve attack rate & QBER check   │
│    • Error Correction & Privacy Amplification               │
│    • SymmetricCrypto: Ephemeral 256-bit AES Key derivation  │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Isolated Gateway Configuration

Stored at `/Users/praveen/Code/QKD-simulation/config.yaml`:

```yaml
server:
  host: "0.0.0.0"
  port: 8080
  workers: 2
  trustProxy: true
  connectTimeoutMs: 5000
  readTimeoutMs: 15000
  compression: false

tls:
  enabled: false

upstreams:
  - id: qkd-java-service
    url: "http://127.0.0.1:8081"
    weight: 1
    healthPath: "/api/qkd/encrypt?message=healthcheck"
    maxConnections: 500

routes:
  - path: "/api/qkd"
    upstreams: ["qkd-java-service"]
    rateLimit:
      windowMs: 60000
      maxRequests: 500
      algorithm: token-bucket
      storage: memory

  - path: "/"
    upstreams: ["qkd-java-service"]

loadBalancing:
  strategy: power-of-two

resilience:
  retry:
    enabled: true
    maxAttempts: 3
    backoff: full-jitter
    baseDelayMs: 100
    maxDelayMs: 5000
    budgetPercent: 20
  circuitBreaker:
    mode: adaptive
    failureThreshold: 20
    recoveryTimeMs: 10000

rateLimit:
  enabled: true
  storage: memory
  algorithm: token-bucket
  windowMs: 60000
  maxRequests: 500
  headers: true

cache:
  enabled: false

discovery:
  mode: static
  health:
    active:
      enabled: true
      intervalMs: 10000
      timeoutMs: 3000
      healthyThreshold: 2
      unhealthyThreshold: 3
    passive:
      enabled: true

observability:
  logging:
    level: info
    accessLog: true
  metrics:
    enabled: true
    path: "/metrics"
    histograms: true

admin:
  enabled: true
  pathPrefix: "/__admin"
```

---

## 🔬 BB84 Quantum Key Distribution Protocol Explained

The Java backend simulates the renowned **BB84 Quantum Cryptography Protocol**:
1. **Photon Polarization State Encoding**: Alice generates random qubits and passes them through either a rectilinear basis ($+$, with angles $0^\circ$ and $90^\circ$) or a diagonal basis ($\times$, with angles $45^\circ$ and $135^\circ$).
2. **Channel Transmission with Eavesdropping (Eve)**:
   - Configured Eve attack rate: `0.15` (15% interception probability).
   - In quantum mechanics (Heisenberg Uncertainty & No-Cloning Theorem), any attempt by Eve to measure the photon in the wrong basis disturbs its quantum state.
3. **Key Sifting**: Bob measures photons in random bases. Alice and Bob publicly compare only the *basis choices*, retaining bits where both chose identical bases.
4. **QBER (Quantum Bit Error Rate) Threshold Verification**:
   - Alice and Bob compare a randomized sample of their sifted keys.
   - If `QBER > 0.05` (5%), the protocol detects Eve's interference and aborts, safely discarding the key and preventing man-in-the-middle attacks (returns HTTP 500 error).
5. **Privacy Amplification & Symmetric AES Encryption**:
   - If `QBER <= 0.05`, the error-corrected bit stream is hashed into a secure **256-bit AES key**.
   - The payload message is encrypted using AES/CBC/PKCS5Padding and returned to the client alongside the Base64 key.
   - The key is **ephemeral** and never persisted on the server.

---

## 🚀 How to Run & Verify

### Step 1: Start the Java Spring Boot Docker Container
```bash
docker run -d --name qkd-simulator -p 8081:8081 qkd-simulation:latest
```

### Step 2: Start Ninja Reverse Proxy with Isolated QKD Config
```bash
cd /Users/praveen/Code/Backend/reverse-proxy
node dist/index.js --config /Users/praveen/Code/QKD-simulation/config.yaml
```

### Step 3: Run Full Automated Verification Suite
```bash
node tests/java-qkd-gateway-verification.mjs
```

Expected Output:
```
═══════════════════════════════════════════════════════════════════
⚛️  JAVA SPRING BOOT QKD SIMULATION + NINJA REVERSE PROXY TEST SUITE
═══════════════════════════════════════════════════════════════════
Gateway Target: http://127.0.0.1:8080

✅ [PASS] [1/10] Gateway Readiness Probe (/__ready) (25ms)
✅ [PASS] [2/10] Upstream Health & Load Balancer Telemetry (/__lb-stats) (4ms)
✅ [PASS] [3/10] QKD BB84 Key Exchange & Message Encryption (GET /api/qkd/encrypt) (19ms)
✅ [PASS] [4/10] Ephemeral 256-bit AES Quantum Key Validation (0ms)
✅ [PASS] [5/10] QKD Quantum Decryption (POST /api/qkd/decrypt) (20ms)
✅ [PASS] [6/10] End-to-End Quantum Encryption/Decryption Roundtrip Fidelity (0ms)
✅ [PASS] [7/10] Gateway Telemetry & Tracing Headers Propagation (6ms)
✅ [PASS] [8/10] Resilient Error Handling for Invalid Quantum Key (POST /api/qkd/decrypt) (9ms)
✅ [PASS] [9/10] High-Concurrency Multi-Client Quantum Simulation (50 concurrent exchanges) (170ms)
✅ [PASS] [10/10] Prometheus Observability Metrics & Upstream Health Gauge (3ms)

═══════════════════════════════════════════════════════════════════
RESULTS: 10/10 TESTS PASSED (100% Success Rate)
═══════════════════════════════════════════════════════════════════
```

---

## 📊 Prometheus & Observability Snapshot

Curl scrape from `http://127.0.0.1:8080/metrics`:
```promql
# HELP ninja_upstream_status Health status of the upstream (1 = UP, 0 = DOWN)
# TYPE ninja_upstream_status gauge
ninja_upstream_status{upstream_id="qkd-java-service"} 1

# HELP ninja_http_requests_total Total number of HTTP requests processed by the proxy
# TYPE ninja_http_requests_total counter
ninja_http_requests_total{method="GET",path="/api/qkd/encrypt",status="200",upstream_id="qkd-java-service",tenant_id="none"} 618
ninja_http_requests_total{method="POST",path="/api/qkd/decrypt",status="200",upstream_id="qkd-java-service",tenant_id="none"} 42
ninja_http_requests_total{method="POST",path="/api/qkd/decrypt",status="400",upstream_id="qkd-java-service",tenant_id="none"} 2
```

---

## 📈 Performance & Autocannon Benchmark

| Metric | Measured Value |
| :--- | :--- |
| **Peak Throughput** | `19,023 req/sec` |
| **Average Burst Throughput** | `15,130.8 req/sec` |
| **p50 Latency (Rate-Limited Burst)** | `1 ms` |
| **p99 Latency (Rate-Limited Burst)** | `5 ms` |
| **p50 Latency (Quantum Simulation End-to-End)** | `5 ms` |
| **Average Latency (Quantum Simulation End-to-End)** | `7.62 ms` |
| **Burst Protection** | HTTP 429 Too Many Requests enforced via Token Bucket |
| **TCP Connection Drops** | `0` |
