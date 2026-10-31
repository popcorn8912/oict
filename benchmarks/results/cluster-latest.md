# Cluster benchmark

3 OICT instances · 1 PostgreSQL database · 40 concurrent shoppers × 15 purchases · every order sent as a 4-request retry storm across random instances · 5% of purchases race a price change. Seed 7.

| Check | Result |
|---|---:|
| Intended purchases | 600 |
| Orders in database | **600** |
| Duplicate orders | **0** |
| Orders priced differently from the confirmation | 0 |
| Order requests sent | 2860 |
| Created / replayed / blocked as already used | 600 / 302 / 1444 |
| Re-confirms after price races | 172 |
| Unexpected errors | 0 |
| Order latency p50 / p95 / p99 | 199.2 / 380.4 / 467.5 ms |
| Throughput | 486 req/s |

Reproduce with `npm run bench:cluster`. Single-machine run with synthetic data: correctness results are the point; latency is indicative only.
