# 🛠️ Operational & Utility Scripts

This directory contains standalone CLI tools and maintenance scripts used during development, deployment, and testing.

---

## Script Catalog

| Script | Purpose | Usage |
|---|---|---|
| `generate-certs.sh` | Generates self-signed TLS certificates (`cert.pem`, `key.pem`) for local development. | `bash scripts/generate-certs.sh` |
| `benchmark.ts` | Lightweight Node.js concurrency benchmark tool for firing batch HTTP/HTTPS requests. | `node --loader ts-node/esm scripts/benchmark.ts <url> <requests> <concurrency>` |
| `interactive-algo-test.ts` | Interactive CLI tool for visualizing load balancing and rate limiting algorithm behavior. | `npx tsx scripts/interactive-algo-test.ts` |
| `verify-all-features.ts` | Standalone end-to-end verification script testing proxy features sequentially. | `npx tsx scripts/verify-all-features.ts` |
| `migrate-config.ts` | Schema migration tool for converting legacy config formats to modern `proxy.yaml`. | `npx tsx scripts/migrate-config.ts` |

---

## Detailed Usage

### 1. Generating TLS Certificates (`generate-certs.sh`)
Generates an RSA 2048-bit key and self-signed certificate valid for 365 days:
```bash
bash scripts/generate-certs.sh
```
Output:
* `cert.pem` (Public certificate)
* `key.pem` (Private key)

### 2. Custom Concurrency Benchmark (`benchmark.ts`)
```bash
# Benchmark https://localhost:8443/ with 5,000 requests and 50 concurrent connections
npx tsx scripts/benchmark.ts https://localhost:8443/ 5000 50
```
