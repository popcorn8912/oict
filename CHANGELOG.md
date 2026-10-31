# Changelog

All notable changes to the OICT specification and reference implementation. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.3.0] — 2026-10-31

### Security
- **Signed access tokens replace bare grant ids.** Grant-scoped requests now require `Authorization: Bearer <JWT>` (RFC 9068 shape with `grant_id`). The service verifies signature, issuer, audience and lifetime, and refuses any caller who is not the grant's subject (new rules MPA-7, MPA-8). Knowing a grant id is no longer enough to spend under it.
- **Confirmations are Ed25519-signed JWS** (`typ: oict-confirmation+jwt`). Anyone can verify them from `/.well-known/jwks.json` (new rule STB-9); only the service can issue them.
- Strict JOSE handling: EdDSA only (no `alg: none`, no shared-secret algorithms), mandatory `kid` and `typ`, so tokens cannot be confused across types.
- Key rotation: extra verification keys from a JWK Set; trusting an external authorization server's issuer and keys.

### Added
- Append-only audit trail (`audit_events`, protected by a database trigger): grants issued and revoked, draft carts, orders, and refused order attempts with their reason. The order event is written in the same transaction as the order. `GET /v1/audit` returns a consumer's own trail.
- Prometheus metrics at `/metrics`: requests by route template and status, latency histogram, orders created and replayed, refusals by OICT error code, build info.
- Structured JSON access logs with request ids; `X-Request-Id` is propagated to responses and audit events.
- 7 conformance cases (46 total), auth and observability tests, multi-instance checks for shared keys, audit atomicity and append-only enforcement.

### Changed
- `OICT_SECRET` is replaced by `OICT_SIGNING_KEY` (64 hex characters or a PEM Ed25519 key). `OICT_SECRET` is still read as a deprecated alias.
- The legacy `Authorization: OICT-Grant <id>` header is refused unless `OICT_ALLOW_GRANT_HEADER=1`.

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
