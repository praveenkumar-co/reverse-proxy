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
