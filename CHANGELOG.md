# Changelog

All notable changes to the OICT specification and reference implementation. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.2.0] — 2026-10-30

### Added
- **PostgreSQL store.** The reference server can now run as many instances sharing one database. Duplicate-purchase protection (IDM-2..4), commit-time state binding (STB-7), lost-update-free state versions (STB-1) and cascading revocation (REV-1, REV-2) are enforced by the database with primary keys, row locks and single-statement updates.
- Forward-only schema migrations, applied on start under a PostgreSQL advisory lock so concurrent roll-outs are safe.
- Zero-dependency PostgreSQL driver: SCRAM-SHA-256 / MD5 / cleartext authentication, optional TLS, parameterised queries, connection pooling.
- Multi-instance test suite (`npm run test:cluster`): three server processes on one database; retry storms (25 rounds × 40 requests), concurrent selection changes, cross-instance revocation and price changes.
- Cluster load benchmark (`npm run bench:cluster`) with database-level invariant checks and latency percentiles.
- `OICT_SECRET`, `OICT_DATABASE_URL`, `OICT_DB_POOL_SIZE`, `OICT_INSTANCE_ID` configuration; graceful shutdown on SIGTERM.
- `X-OICT-Instance` response header; `/healthz` now reports the store and instance.
- Docker Compose stack with PostgreSQL and two instances; CI job that runs the cluster tests, the conformance suite on PostgreSQL and the cluster benchmark.
- [Deployment guide](docs/deployment.md).

### Changed
- The engine API is now asynchronous and runs on a pluggable `Store` (`MemoryStore` or `PostgresStore`).
- The 39 conformance cases are unchanged and pass on both stores; a concurrent-burst unit test was added.

## [0.1.0] — 2026-10-29

### Added
- Specification draft v0.1: participants & delegation (`MPA`, `DLG`, `REV`), state–order binding (`STB`), AI agent controls (`AGT`), minor protection (`MIN`), idempotency & errors (`IDM`, `ERR`), non-normative protocol profiles, security considerations.
- JSON Schemas for participants, grants, interaction snapshots, confirmation claims, orders and errors.
- Zero-dependency reference engine and HTTP server with fixture hooks.
- Conformance suite: 39 cases, CLI runner with JSON report output.
- Anomaly-injection benchmark comparing OICT with a naive checkout-only baseline.
- Interactive browser demo and project site.
