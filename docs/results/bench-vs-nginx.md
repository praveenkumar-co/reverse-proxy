# ninja-reverse-proxy vs nginx — real-traffic benchmark

Generated: 2026-11-05T14:03:09.269Z

## Machine

- CPU: Apple M5 (10 logical cores)
- RAM: 16.0 GB
- OS: ProductName:		macOS / ProductVersion:		27.0 / BuildVersion:		26A428 /
- Node: v20.20.2
- nginx: nginx version: nginx/1.31.8
- Workers (both targets): 4
- Warmup: 10s, stage duration: 30s per concurrency

## Results

| Target | Payload | Concurrency | RPS | p50 (ms) | p99 (ms) | p99.9 (ms) | Errors | Peak RSS (MB) | Peak JS heap (MB) | Peak arrayBuffers (MB) | Peak external (MB) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| nginx | 1KB | 100 | 44740 | 2.07 | 8.52 | 59.66 | 0 | 32.1 | n/a | n/a | n/a |
| nginx | 1KB | 500 | 45691 | 9.90 | 80.00 | 447.01 | 25 | 20.2 | n/a | n/a | n/a |
| nginx | 1MB | 100 | 1734 | 54.69 | 90.84 | 189.13 | 0 | 43.4 | n/a | n/a | n/a |
| nginx | 1MB | 500 | 641 | 369.97 | 1855.32 | 1985.14 | 1487 | 92.3 | n/a | n/a | n/a |
| ninja | 1KB | 100 | 18438 | 4.91 | 20.66 | 49.18 | 0 | 721.3 | 94.0 | 0.5 | 2.9 |
| ninja | 1KB | 500 | 19650 | 23.76 | 71.48 | 325.82 | 0 | 755.8 | 98.4 | 0.7 | 3.0 |
| ninja | 1MB | 100 | 1732 | 56.66 | 83.76 | 112.97 | 0 | 823.0 | 40.5 | 42.0 | 44.4 |
| ninja | 1MB | 500 | 668 | 339.10 | 1841.89 | 1978.79 | 1424 | 842.9 | 24.9 | 39.6 | 41.9 |
| ninja, all features on | 1KB | 100 | 34605 | 2.81 | 5.25 | 9.49 | 0 | 535.7 | 45.1 | 0.5 | 2.8 |
| ninja, all features on | 1KB | 500 | 33924 | 13.31 | 96.92 | 202.56 | 0 | 609.4 | 79.6 | 0.4 | 2.8 |
| ninja, all features on | 1MB | 100 | 1758 | 54.88 | 83.79 | 104.68 | 0 | 1025.8 | 44.1 | 64.0 | 66.4 |
| ninja, all features on | 1MB | 500 | 1285 | 329.58 | 1287.76 | 1846.59 | 112 | 1655.9 | 116.5 | 133.1 | 135.4 |

JS heap / arrayBuffers / external (nginx rows: n/a, no such endpoint) break Peak RSS down into V8 heap vs. native Buffers vs. other native memory (sockets, zlib/TLS contexts) — added after the F1b run exposed a 'timeout' EventEmitter-listener leak on pooled upstream sockets (fixed; see tests/production-gates.mjs Gate 7) so a future RSS regression shows which bucket grew instead of being assumed.

Numbers are reported as measured — no tuning applied to only one side beyond matching worker counts.
