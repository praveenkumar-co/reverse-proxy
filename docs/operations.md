# Operations Guide

## Starting
```bash
node dist/index.js --config config.yaml
```

## Admin Endpoints
- `GET /__lb-stats` — Load balancer statistics
- `GET /metrics` — Prometheus metrics
- `GET /__cache-stats` — Cache hit/miss statistics
- `GET /__registry` — Service registry
