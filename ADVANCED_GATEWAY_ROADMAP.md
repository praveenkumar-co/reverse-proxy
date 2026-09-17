# 🚀 Ninja Reverse Proxy: Advanced API Gateway Architecture & Roadmap

## 📌 Executive Summary & Architectural Vision
`ninja-reverse-proxy` already features a robust high-throughput foundation:
* **Master-Worker Cluster** with IPC Watchdog.
* **12 Load Balancing Algorithms** (Power-of-Two Choices, Weighted Round Robin, IP Hash, Least Connections, Latency).
* **5 Rate Limiting Algorithms** (Token Bucket, Sliding Window Counter, Sliding Window Log, Fixed Window, Leaky Bucket).
* **Hybrid L1/L2 Caching** (In-memory LRU + Redis L2 + Stale-While-Revalidate).
* **Resilience Patterns** (Bulkhead, Adaptive Circuit Breaker, Exponential Backoff with Full Jitter).
* **Multi-Language Verification**: Node.js Express, Python FastAPI, Java Spring Boot, and Kotlin Ktor.

To elevate this gateway to match industry-standard proxies like **Envoy**, **Cloudflare**, and **Kong**, this document outlines the **Top 6 Advanced Software-Level Capabilities** designed for implementation without hardware dependencies.

---

## 🗺️ Architectural Capabilities Overview

```
                                [ Incoming Client Traffic ]
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              NINJA REVERSE PROXY GATEWAY                               │
│                                                                                        │
│  [1. WAF & Bot Defense] ──────► [2. Schema Validator] ──────► [3. Rate Limiter (Token)]│
│  • SQLi / XSS Inspection        • OpenAPI / JSONSchema        • Burst & Quota Control  │
│  • CIDR IP Filter & Path        • Early 422 Rejection                                  │
│                                                                                        │
│                                            │                                           │
│                                            ▼                                           │
│  [4. Chaos Fault Injection] ─────────────────────────────────────────────────────────┐ │
│  • Injected Latency (e.g. 500ms @ 5%)                                                │ │
│  • Injected Errors (HTTP 500 / 503 / Aborts)                                         │ │
│                                                                                      │ │
│                                            │                                         │ │
│                                            ▼                                         │ │
│  [5. Canary & Traffic Splitter] ───────────────────────┐                             │ │
│  • 90% Production / 10% Canary                         │                             │ │
│  • Header / Cookie Overrides (X-Canary: beta)          │                             │ │
│                                                        │                             │ │
│                   │                                    │ (Dark Launch Clone)         │ │
│                   ▼                                    ▼                             │ │
│        [Primary Upstream Dispatch]          [6. Async Traffic Shadowing]             │ │
│        • Active & Passive Health Checks     • Fire-and-Forget Asynchronous Clone     │ │
│        • Circuit Breaker & Bulkhead         • Zero Client Impact / Response Dropped  │ │
└───────────────────┬────────────────────────────────────┬─────────────────────────────┘
                    │                                    │
                    ▼                                    ▼
       ┌────────────────────────┐           ┌────────────────────────┐
       │   Primary Microservice │           │    Shadow / New V2     │
       │   (e.g., Kotlin Ktor)  │           │   (e.g., Java QKD)     │
       └────────────────────────┘           └────────────────────────┘
```

---

## 🔍 Detailed Feature Specifications

### 1. 🪞 Traffic Shadowing / Request Mirroring (Dark Launching)

#### Problem Solved
Deploying a new microservice version (or a major framework rewrite) to production is risky. Synthetic tests never fully capture real customer query variations, edge-case headers, and payload nuances.

#### How It Works
1. Client sends a request to `/api/*`.
2. The proxy routes the request to the primary upstream and awaits the response.
3. Simultaneously and **asynchronously**, the proxy clones the request (headers, method, body, query parameters) and dispatches it to a designated `shadow` upstream.
4. The client **never waits** for the shadow upstream. The shadow response is discarded, and its errors do not affect the client.
5. Latency, status codes, and error differentials between Primary and Shadow are exported to Prometheus metrics.

#### Declarative Configuration Syntax (`config.yaml`)
```yaml
routes:
  - path: "/api"
    upstreams: ["kotlin-ktor-service"]
    shadow:
      upstream: "java-qkd-service"
      percentage: 10   # Mirror 10% of live traffic asynchronously
      sampleMode: random # random | header | hash
```

#### Performance & Safety Measures
* Non-blocking `setImmediate` or unawaited Promise dispatch.
* Shadow socket timeouts enforced strictly (max 2000ms).
* Shadow errors isolated to prevent memory leaks or process crashes.

---

### 2. 🚦 Canary & Blue-Green Traffic Splitting

#### Problem Solved
Enables safe progressive rollouts, A/B testing, and instant zero-downtime rollbacks without requiring complex Kubernetes ingress controllers.

#### Routing Strategies
1. **Weighted Percentage**: Send 90% of requests to `v1` and 10% to `v2`.
2. **Header-Based**: Requests with `X-Canary: beta` or `X-User-Role: internal` route 100% to `v2`.
3. **Cookie-Based**: Sticky browser sessions routed based on cookie `canary_version=v2`.
4. **Deterministic User Hashing**: `hash(userId or clientIp) % 100 < 10` ensures an individual user consistently sees the same backend across reloads.

#### Declarative Configuration Syntax (`config.yaml`)
```yaml
routes:
  - path: "/api/orders"
    canary:
      enabled: true
      rules:
        - upstream: "orders-v2"
          weight: 15 # 15% traffic
          match:
            headers:
              X-Stage: "beta"
            cookies:
              canary: "true"
        - upstream: "orders-v1"
          weight: 85 # 85% traffic
      fallback: "orders-v1"
```

---

### 3. 💥 Envoy-Style Chaos Fault Injection

#### Problem Solved
Verifies that downstream clients, microservices, and frontends properly handle network degradation, timeouts, and upstream server errors before incidents happen in production.

#### Injected Fault Types
* **Delay / Latency**: Adds simulated network latency (e.g. 500ms fixed or jittered) to a specified percentage of requests.
* **HTTP Abort / Status Fault**: Returns HTTP 500, 502, or 503 immediately without calling the backend.
* **TCP Stream Reset**: Aborts the client connection mid-stream (`socket.destroy()`) to test client socket reconnection logic.

#### Declarative Configuration Syntax (`config.yaml`)
```yaml
chaos:
  enabled: true
  faults:
    - path: "/api/users"
      delay:
        percentage: 10       # 10% of requests
        fixedMs: 450         # Add 450ms artificial lag
      abort:
        percentage: 2        # 2% of requests
        httpStatus: 503      # Return 503 Service Unavailable
        responseBody: '{"error": "Simulated Chaos Fault"}'
```

---

### 4. 🛡️ Edge Web Application Firewall (WAF) & Security Layer

#### Problem Solved
Stops malicious payloads, directory traversal, SQL injection, cross-site scripting (XSS), and aggressive scraping at the proxy level before queries reach your backends or databases.

#### Inspection Vectors
1. **SQLi Detection**: Regex and keyword pattern matching on query parameters, request paths, and JSON bodies (`UNION SELECT`, `OR 1=1`, `--`, `INFORMATION_SCHEMA`).
2. **XSS Detection**: Identifying unescaped script injections (`<script>`, `javascript:`, `onload=`, `onerror=`).
3. **Directory Traversal**: Blocking `../`, `..%2f`, and `%2e%2e/`.
4. **IP Blacklisting & CIDR Filtering**: Denying known malicious IPs or entire subnets (`10.0.0.0/8`, `192.168.1.0/24`).
5. **Bot & Scanner Mitigation**: Blocking known penetration scanners (e.g. `nikto`, `sqlmap`, `nmap`, `curl/7.*` if disallowed).

#### Declarative Configuration Syntax (`config.yaml`)
```yaml
waf:
  enabled: true
  mode: blocking # blocking | monitor-only
  rules:
    sqlInjection: true
    crossSiteScripting: true
    pathTraversal: true
    blockBadUserAgents: true
  ipFilter:
    denylist:
      - "198.51.100.14"
      - "203.0.113.0/24"
    allowlist: []
```

---

### 5. 📜 Contract Gateway: Schema Validation at the Edge

#### Problem Solved
Eliminates backend overhead by rejecting malformed payloads before they reach downstream services.

#### Capabilities
* Validates incoming JSON payloads against a JSON Schema or OpenAPI request body specification.
* If validation fails: Immediately returns **`422 Unprocessable Entity`** with a structured list of schema errors.
* Keeps backend microservice controllers lean and protected from type corruption or invalid data.

#### Declarative Configuration Syntax (`config.yaml`)
```yaml
routes:
  - path: "/api/users"
    methods: ["POST"]
    schemaValidation:
      enabled: true
      schema:
        type: object
        required: ["user"]
        properties:
          user:
            type: object
            required: ["email", "password", "username"]
            properties:
              email: { type: string, format: email }
              password: { type: string, minLength: 8 }
              username: { type: string, minLength: 3 }
```

---

### 6. 🌐 OpenTelemetry (OTel) Distributed Tracing (W3C Standard)

#### Problem Solved
Standardizes tracing across polyglot microservices (Node, Python, Java, Kotlin) using standard **W3C Trace Context** headers.

#### Capabilities
* Injects and propagates standard `traceparent` headers:
  $$\texttt{00-<32-hex-trace-id>-<16-hex-parent-span-id>-<flags>}$$
* Measures Gateway Span Duration:
  * `gateway.receive` $\rightarrow$ `rate_limiter` $\rightarrow$ `cache_lookup` $\rightarrow$ `upstream_roundtrip` $\rightarrow$ `client_response`
* Compatible with **Jaeger**, **Zipkin**, **Tempo**, and **DataDog**.

---

## 📊 Summary & Feature Comparison Matrix

| Feature | Primary Purpose | Real-World Precedent | Performance Impact |
| :--- | :--- | :--- | :--- |
| **Traffic Shadowing** | Risk-free testing of new services with live traffic | Netflix Zuul / Envoy Mirroring | $< 0.1\text{ ms}$ (Async non-blocking) |
| **Canary Splitting** | Progressive zero-downtime rollouts | Cloudflare Workers / Traefik | $< 0.2\text{ ms}$ (Route matching) |
| **Chaos Fault Injection** | Resilience & circuit-breaker validation | Envoy Fault Injection / Gremlin | $0\text{ ms}$ (Conditional delay/abort) |
| **Edge WAF** | OWASP Top 10 security & bot defense | AWS WAF / Cloudflare Edge | $0.5 - 1.5\text{ ms}$ (String/Regex scan) |
| **Schema Validation** | Immediate rejection of invalid payloads | Kong Schema Validator / Zuplo | $0.3 - 0.8\text{ ms}$ (In-memory JSONSchema) |
| **W3C Distributed Tracing**| Microservice latency breakdown | OpenTelemetry / Jaeger | $< 0.1\text{ ms}$ (Span header generation) |

---

## 💬 Discussion & Next Steps

Before implementing any code:
1. **Which feature would provide the highest immediate value for your project?**
   * *Recommendation*: **Traffic Shadowing** (allows mirroring real traffic from Kotlin to Java) or **Chaos Fault Injection** (provides interactive resilience testing).
2. **Configuration Style**: Should we configure these features globally in `config.yaml` or on a per-route basis?
3. **Observability Integration**: Each feature can publish dedicated Prometheus metrics and Grafana panels (e.g. `ninja_shadow_requests_total`, `ninja_waf_blocks_total`, `ninja_chaos_faults_total`).
