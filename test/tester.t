cat config.yaml
server:
  listen: 8080
  httpsPort: 8443
  workers: 2

  loadBalancing:
    strategy: round-robin
    failureThreshold: 3
    recoveryTimeMs: 15000

    retry:
      maxAttempts: 2
      statusCodes: [502, 503, 504]

  upstreams:
    - id: backend-1
      url: http://localhost:3000

    - id: backend-2
      url: http://localhost:3001

  paths:
    - path: /
      upstream:
        - backend-1
        - backend-2
      rateLimit:
        windowMs: 60000
        maxRequests: 5
      sticky: true 

  headers:
    - key: X-Forwarded-For
      value: client_ip

  cache:
    enabled: false
    host: localhost
    port: 6379
    ttlSeconds: 60
ubuntu@ip-172-31-89-102:~/reverse-proxy-demo$ 


------------------------------------------------

ubuntu@ip-172-31-89-102:~/reverse-proxy-demo$ curl -k -X POST https://localhost:8443/__registry/register \
-H "Content-Type: application/json" \
-d '{
  "id":"backend-3",
  "url":"http://localhost:3002",
  "metadata":{
    "dynamic":"true"
  }
}'
{"message":"Service backend-3 registered!","service":{"id":"backend-3","url":"http://localhost:3002","metadata":{"dynamic":"true"},"registeredAt":1784567704726,"lastHeartbeat":1784567704726,"status":"UP"}}ubuntu@ip-172-31-89-102:~/reverse-proxy-demo$ curl -k https://localhost:8443/__registry
{
  "total": 3,
  "healthy": 3,
  "services": [
    {
      "id": "backend-1",
      "url": "http://localhost:3000",
      "status": "UP",
      "uptime": "69s",
      "lastHeartbeat": "69s ago"
    },
    {
      "id": "backend-2",
      "url": "http://localhost:3001",
      "status": "UP",
      "uptime": "69s",
      "lastHeartbeat": "69s ago"
    },
    {
      "id": "backend-3",
      "url": "http://localhost:3002",
      "status": "UP",
      "uptime": "3s",
      "lastHeartbeat": "3s ago",
      "metadata": {
        "dynamic": "true"
      }
    }
  ]
ubuntu@ip-172-31-89-102:~/reverse-proxy-demo$  curl -khttps://localhost:8443/__registry{
{
  "total": 3,
  "healthy": 2,
  "services": [
    {
      "id": "backend-1",
      "url": "http://localhost:3000",
      "status": "UP",
      "uptime": "109s",
      "lastHeartbeat": "109s ago"
    },
    {
      "id": "backend-2",
      "url": "http://localhost:3001",
      "status": "UP",
      "uptime": "109s",
      "lastHeartbeat": "109s ago"
    },
    {
      "id": "backend-3",
      "url": "http://localhost:3002",
      "status": "DOWN",
      "uptime": "43s",
      "lastHeartbeat": "43s ago",
      "metadata": {
        "dynamic": "true"
      }
    }
  ]
}ubuntu@ip-172-31-89-102:~/reverse-proxy-demo$ 
