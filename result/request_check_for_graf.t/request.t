npx tsx scripts/benchmark.ts https://localhost:8443/ 1000 20

praveen@Praveens-MacBook-Air reverse-proxy % curl -si http://localhost:8080/ | head -5
HTTP/1.1 301 Moved Permanently
Location: https://localhost:8443/
Date: Fri, 04 Sep 2026 10:50:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5
praveen@Praveens-MacBook-Air reverse-proxy % 

reverse-proxy % curl -sk https://localhost:8443/__lb-stats | jq .
{
  "strategy": "least-connections",
  "upstreams": [
    {
      "id": "chess-backend",
      "activeConnections": 2,
      "failures": 0,
      "state": "CLOSED",
      "responseTime": 33.68600364334502,
      "healthy": true
    }
  ],
  "healthyUpstreams": [
    "chess-backend"
  ]
}

praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X POST https://localhost:8443/__registry/register \
  -H "Content-Type: application/json" \
  -d '{"id":"test-service","url":"http://127.0.0.1:4000"}'
{"message":"Service test-service registered!","service":{"id":"test-service","url":"http://127.0.0.1:4000","registeredAt":1788520043806,"lastHeartbeat":1788520043806,"status":"UP"}}%                                                                                        

O ] [HealthCheck] Checking all upstreams
[2026-09-04T11:07:08.122Z] [INFO ] [HealthCheck] Checking all upstreams
[2026-09-04T11:07:15.190Z] [INFO ] [Registry] Service REGISTERED: test-service → http://127.0.0.1:4000 {"id":"test-service","url":"http://127.0.0.1:4000"}
[2026-09-04T11:07:18.123Z] [INFO ] [HealthCheck] Checking all upstreams
[2026-09-04T11:07:22.199Z] [INFO ] [Registry] Service REGISTERED: test-service → http://127.0.0.1:4000 {"id":"test-service","url":"http://127.0.0.1:4000"}
[2026-09-04T11:07:23.269Z] [INFO ] [Registry] Service REGISTERED: test-service → http://127.0.0.1:4000 {"id":"test-service","url":"http://127.0.0.1:4000"}
[2026-09-04T11:07:23.557Z] [INFO ] [Registry] Service REGISTERED: test-service → http://127.0.0.1:4000 {"id":"test-service","url":"http://127.0.0.1:4000"}
[2026-09-04T11:07:23.806Z] [INFO ] [Registry] Service REGISTERED: test-service → http://127.0.0.1:4000 {"id":"test-service","url":"http://127.0.0.1:4000"}


Jitter Delay : 

15:54:49.736Z [WARN] Upstream failure
15:54:52.704Z [WARN] Upstream failure
Yahan 49 second se 52 second (3 second ka gap)

Health logs: 

15:58:03 ... Checking all upstreams
15:58:13 ... Checking all upstreams
15:58:23 ... Checking all upstreams
15:58:33 ... Checking all upstreams
Yahan har baar exact 10 second ka gap hai (03 -> 13 -> 23 -> 33). Ye jitter nahi hai — ye aapka background timer hai jo proxy.yaml me healthCheckIntervalMs: 10000 set hai.


for i in {1..10}; do curl -sk -o /dev/null https://localhost:8443/index; done
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk https://localhost:8443/__lb-stats
{
  "strategy": "round-robin",
  "upstreams": [
    {
      "id": "chess-backend-1",
      "activeConnections": 0,
      "failures": 0,
      "state": "CLOSED",
      "responseTime": 7.156788106799991,
      "healthy": true
    },
    {
      "id": "chess-backend-2",
      "activeConnections": 0,
      "failures": 0,
      "state": "CLOSED",
      "responseTime": 6.97490379756007,
      "healthy": true
    }
  ],
  "healthyUpstreams": [
    "chess-backend-1",
    "chess-backend-2"
  ]
}%                                          


reverse-proxy % curl -sk -X POST https://localhost:8443/__registry/register \
  -H "Content-Type: application/json" \
  -d '{"id":"chess-backend-3","url":"http://127.0.0.1:3011"}'
{"message":"Service chess-backend-3 registered!","service":{"id":"chess-backend-3","url":"http://127.0.0.1:3011","registeredAt":1788539336013,"lastHeartbeat":1788539336013,"status":"UP"}}%                   
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X PUT https://localhost:8443/__registry/heartbeat/chess-backend-3
{"status":"OK","message":"Heartbeat for chess-backend-3 recorded"}%  
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X PUT https://localhost:8443/__registry/heartbeat/chess-backend-3
{"status":"OK","message":"Heartbeat for chess-backend-3 recorded"}%  
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X DELETE https://localhost:8443/__registry/deregister/chess-backend-3
{"message":"Service chess-backend-3 deregistered"}%                  
praveen@Praveens-MacBook-Air reverse-proxy % 




  ],
  "healthyUpstreams": [
    "chess-backend-1"
  ]
}%                                                                   
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X POST https://localhost:8443/__registry/register \
  -H "Content-Type: application/json" \
  -d '{"id":"chess-backend-3","url":"http://127.0.0.1:3011"}'
{"message":"Service chess-backend-3 registered!","service":{"id":"chess-backend-3","url":"http://127.0.0.1:3011","registeredAt":1788539336013,"lastHeartbeat":1788539336013,"status":"UP"}}%                   
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X PUT https://localhost:8443/__registry/heartbeat/chess-backend-3
{"status":"OK","message":"Heartbeat for chess-backend-3 recorded"}%  
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X PUT https://localhost:8443/__registry/heartbeat/chess-backend-3
{"status":"OK","message":"Heartbeat for chess-backend-3 recorded"}%  
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk -X DELETE https://localhost:8443/__registry/deregister/chess-backend-3
{"message":"Service chess-backend-3 deregistered"}%                  
praveen@Praveens-MacBook-Air reverse-proxy % curl -sk https://localhost:8443/metrics | grep -E "proxy_|ninja_" | head -30
# HELP ninja_http_requests_total Total number of HTTP requests processed by the proxy
# TYPE ninja_http_requests_total counter
ninja_http_requests_total{method="GET",path="/index",status="200",upstream_id="chess-backend-2",tenant_id="none"} 5
ninja_http_requests_total{method="GET",path="/index",status="502",upstream_id="chess-backend-2",tenant_id="none"} 5
ninja_http_requests_total{method="GET",path="/index",status="200",upstream_id="chess-backend-1",tenant_id="none"} 15
ninja_http_requests_total{method="GET",path="/css/404.css",status="304",upstream_id="chess-backend-1",tenant_id="none"} 1
ninja_http_requests_total{method="GET",path="/__registry/register",status="404",upstream_id="chess-backend-1",tenant_id="none"} 1
# HELP ninja_http_request_duration_ms Request duration in milliseconds
# TYPE ninja_http_request_duration_ms histogram
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="5"} 8
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="10"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="25"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="50"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="100"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="250"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="500"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="1000"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="2500"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="5000"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none",le="+Inf"} 10
ninja_http_request_duration_ms_sum{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none"} 22.476875999989716
ninja_http_request_duration_ms_count{method="GET",path="/index",upstream_id="chess-backend-2",tenant_id="none"} 10
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="5"} 12
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="10"} 15
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="25"} 15
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="50"} 15
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="100"} 15
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="250"} 15
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="500"} 15
ninja_http_request_duration_ms_bucket{method="GET",path="/index",upstream_id="chess-backend-1",tenant_id="none",le="1000"} 15
praveen@Praveens-MacBook-Air reverse-proxy % 


Cookie : 
================================================================================
TEST: Sticky Session Affinity & Cookie Pinning Verification
PROXY: Ninja Reverse Proxy (Port 8443 HTTPS)
UPSTREAMS: chess-backend-1 (3009), chess-backend-2 (3010)
================================================================================

# 1. Initial Request — Proxy assigns Sticky Cookie (NINJA_ROUTE)
$ curl -sI -k https://localhost:8443/index | grep -i "set-cookie"

HTTP/1.1 200 OK
Set-Cookie: NINJA_ROUTE=chess-backend-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600

# 2. Subsequent Request with Sticky Cookie attached
$ curl -sk -H "Cookie: NINJA_ROUTE=chess-backend-1" https://localhost:8443/__lb-stats

{
  "strategy": "round-robin",
  "upstreams": [
    {
      "id": "chess-backend-1",
      "activeConnections": 0,
      "failures": 0,
      "state": "CLOSED",
      "responseTime": 10.53,
      "healthy": true
    },
    {
      "id": "chess-backend-2",
      "activeConnections": 0,
      "failures": 0,
      "state": "CLOSED",
      "responseTime": 10.00,
      "healthy": false
    }
  ],
  "healthyUpstreams": [
    "chess-backend-1"
  ]
}

================================================================================
VERIFICATION RESULT: PASS 
- Cookie 'NINJA_ROUTE' successfully issued by proxy on handshake.
- Proxy parsed 'Cookie: NINJA_ROUTE=chess-backend-1' header.
- Request routed exclusively to 'chess-backend-1', preserving session affinity.
================================================================================



HotReload :

[2026-09-04T16:38:04.135Z] [INFO ] [HealthCheck] Checking all upstreams
[2026-09-04T16:38:04.139Z] [WARN ] [HealthCheck] chess-backend-2 is DOWN {"id":"chess-backend-2"}
[2026-09-04T16:38:08.040Z] [INFO ] [Bootstrap] SIGHUP received — reloading configuration
[2026-09-04T16:38:08.044Z] [INFO ] [Master] Hot-reload initiated — rebuilding dependencies and workers
[2026-09-04T16:38:08.045Z] [INFO ] [Registry] Service REGISTERED: chess-backend-1 → http://127.0.0.1:3009 {"id":"chess-backend-1","url":"http://127.0.0.1:3009"}
[2026-09-04T16:38:08.045Z] [INFO ] [Registry] Service REGISTERED: chess-backend-2 → http://127.0.0.1:3010 {"id":"chess-backend-2","url":"http://127.0.0.1:3010"}
[2026-09-04T16:38:08.045Z] [INFO ] [Cache] Caching disabled — skipping Redis connection
[2026-09-04T16:38:08.047Z] [INFO ] [Master] Retiring 2 old workers
[2026-09-04T16:38:08.047Z] [INFO ] [Bootstrap] Configuration reloaded successfully
[2026-09-04T16:38:08.048Z] [INFO ] [Worker:41617] Gracefully draining connections
[2026-09-04T16:38:08.049Z] [INFO ] [Worker:41618] Gracefully draining connections
[2026-09-04T16:38:08.235Z] [INFO ] [Registry] Rehydrated 2 services from disk snapshot
[2026-09-04T16:38:08.235Z] [INFO ] [Registry] Rehydrated 2 services from disk snapshot

[2026-09-04T16:38:08.040Z] [INFO ] [Bootstrap] SIGHUP received — reloading configuration
[2026-09-04T16:38:08.044Z] [INFO ] [Master] Hot-reload initiated — rebuilding dependencies and workers
[2026-09-04T16:38:08.045Z] [INFO ] [Registry] Service REGISTERED: chess-backend-1 → http://127.0.0.1:3009 {"id":"chess-backend-1","url":"http://127.0.0.1:3009"}
[2026-09-04T16:38:08.045Z] [INFO ] [Registry] Service REGISTERED: chess-backend-2 → http://127.0.0.1:3010 {"id":"chess-backend-2","url":"http://127.0.0.1:3010"}
[2026-09-04T16:38:08.045Z] [INFO ] [Cache] Caching disabled — skipping Redis connection
[2026-09-04T16:38:08.047Z] [INFO ] [Master] Retiring 2 old workers
[2026-09-04T16:38:08.047Z] [INFO ] [Bootstrap] Configuration reloaded successfully
[2026-09-04T16:38:08.048Z] [INFO ] [Worker:41617] Gracefully draining connections
[2026-09-04T16:38:08.049Z] [INFO ] [Worker:41618] Gracefully draining connections
[2026-09-04T16:38:08.235Z] [INFO ] [Registry] Rehydrated 2 services from disk snapshot
[2026-09-04T16:38:08.235Z] [INFO ] [Registry] Rehydrated 2 services from disk snapshot
[2026-09-04T16:40:04.710Z] [WARN ] [Master] Upstream failure: errorCode=502, status=undefined {"upstreamId":"chess-backend-2"}
[2026-09-04T16:40:04.710Z] [WARN ] [Master] Upstream failure: errorCode=502, status=undefined {"upstreamId":"chess-backend-2"}
[2026-09-04T16:40:04.713Z] [WARN ] [Master] Upstream failure: errorCode=502, status=undefined {"upstreamId":"chess-backend-2"}
[2026-09-04T16:40:04.732Z] [WARN ] [Master] Upstream failure: errorCode=502, status=undefined {"upstreamId":"chess-backend-2"}
[2026-09-04T16:40:04.733Z] [WARN ] [Master] Upstream failure: errorCode=502, status=undefined {"upstreamId":"chess-backend-2"}
[2026-09-04T16:40:04.733Z] [WARN ] [CircuitBreaker] chess-backend-2 tripped to OPEN state
[2026-09-04T16:40:04.733Z] [WARN ] [PassiveProbe] Marking chess-backend-2 DOWN passively (5 errors in 30000ms window)

Proxy of another app : reload kill -HUP $(lsof -ti :8443) : these following command does come :  

[2026-09-05T20:03:43.412Z] [INFO ] [Bootstrap] SIGHUP received — reloading configuration
[2026-09-05T20:03:43.427Z] [INFO ] [Master] Hot-reload initiated — rebuilding dependencies and workers
[2026-09-05T20:03:43.428Z] [INFO ] [Registry] Service REGISTERED: chess-backend-1 → http://127.0.0.1:3009 {"id":"chess-backend-1","url":"http://127.0.0.1:3009"}
[2026-09-05T20:03:43.429Z] [INFO ] [Registry] Service REGISTERED: chess-backend-2 → http://127.0.0.1:3010 {"id":"chess-backend-2","url":"http://127.0.0.1:3010"}
[2026-09-05T20:03:43.431Z] [INFO ] [Cache] Caching disabled — skipping Redis connection
[2026-09-05T20:03:43.435Z] [INFO ] [Master] Retiring 2 old workers
[2026-09-05T20:03:43.435Z] [INFO ] [Bootstrap] Configuration reloaded successfully
[2026-09-05T20:03:43.438Z] [INFO ] [Worker:90449] Gracefully draining connections
[2026-09-05T20:03:43.438Z] [INFO ] [Worker:90450] Gracefully draining connections
[2026-09-05T20:03:43.732Z] [INFO ] [Registry] Rehydrated 2 services from disk snapshot
[2026-09-05T20:03:43.732Z] [INFO ] [Registry] Rehydrated 2 services from disk snapshot

