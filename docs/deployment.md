# Running OICT on PostgreSQL

The reference server runs in two modes:

| Mode | When | State lives in |
|---|---|---|
| **Memory** (default) | Local development, tests, demos — exactly one process | Process memory; lost on restart |
| **PostgreSQL** | Anything with more than one instance, or anything that must survive a restart | One shared PostgreSQL database |

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `OICT_DATABASE_URL` | for PostgreSQL mode | `postgres://user:password@host:5432/db`. Add `?sslmode=require` or `?sslmode=verify-full` for TLS. |
| `OICT_SIGNING_KEY` | with a database | Ed25519 private key: a 32-byte seed as 64 hex characters, or a PEM key. Signs confirmations and access tokens. **Every instance must use the same key**, or tokens issued by one instance are rejected by the others. |
| `OICT_SIGNING_KEY_FILE` | no | Read the signing key from a file (for mounted secrets). |
| `OICT_TRUSTED_JWKS_FILE` | no | A JWK Set of extra Ed25519 public keys to accept: the previous key during rotation, or an external authorization server's keys. |
| `OICT_ISSUER` | no | `iss` of tokens this service signs (default `urn:oict:reference`). |
| `OICT_TRUSTED_ISSUERS` | no | Comma-separated issuers whose access tokens are accepted (default: `OICT_ISSUER`). |
| `OICT_AUDIENCE` | no | Required `aud` of access tokens (default `oict`). |
| `OICT_ACCESS_TOKEN_TTL` | no | Lifetime of access tokens this service issues, in seconds (default 900). |
| `OICT_LOG` | no | `json` (default): one JSON line per request on stdout. `off` disables access logs. |
| `OICT_DB_POOL_SIZE` | no | Connections per instance (default 10). |
| `OICT_INSTANCE_ID` | no | Name shown in `/healthz` and the `X-OICT-Instance` response header. |
| `PORT` | no | Listen port (default 8787). |
| `OICT_TEST_HOOKS` | no | `1` exposes `/v1/_test/*` fixture endpoints. Never enable in production. |
| `OICT_ALLOW_GRANT_HEADER` | no | `1` accepts the legacy `Authorization: OICT-Grant <id>` header. Never enable in production. |

```bash
export OICT_DATABASE_URL=postgres://oict:oict@localhost:5432/oict
export OICT_SIGNING_KEY=$(openssl rand -hex 32)
npm start
```

Or start two instances and a database with one command:

```bash
docker compose up --build      # oict-1 on :8787, oict-2 on :8788, then a conformance run
```

## Schema and migrations

Each instance applies pending migrations when it starts. A PostgreSQL advisory lock serializes concurrent start-ups, so a whole fleet can roll out at once without a separate migration job. Applied versions are recorded in `oict_schema_migrations`. See [`src/store/postgres/migrations.ts`](../src/store/postgres/migrations.ts).

| Table | Holds |
|---|---|
| `participants` | Platforms, developers, applications, consumers, agents (with check constraints for MPA-6 and age bands) |
| `grants` | Grants and their delegation chain (`parent_grant_id`) |
| `catalog_items`, `catalog_variants` | Synthetic catalog with `variant_version` / `price_version` |
| `sessions` | Current selection and `state_version` per session |
| `draft_carts` | Agent-prepared carts |
| `orders` | Orders with the exact snapshot they were placed against |
| `consumed_confirmations` | One row per used confirmation nonce |
| `idempotency_keys` | One row per `(grant, Idempotency-Key)` |

## How the guarantees hold across instances

No rule that protects money depends on process memory. Each is enforced by the database:

| Guarantee | Rule | Mechanism |
|---|---|---|
| A retried request returns the original order | IDM-2 | Primary key on `idempotency_keys (grant_id, idempotency_key)`. A concurrent duplicate waits on the key, then reads and replays the winner's order. |
| Reusing a key for a different purchase is refused | IDM-3 | The stored request fingerprint is compared before replaying. |
| One confirmation buys once, whatever key the client invents | IDM-4 | Primary key on `consumed_confirmations.nonce`, claimed inside the order transaction. |
| A price or selection change between "check" and "write" cannot slip through | STB-7 | The order transaction locks the session row (`FOR UPDATE`) and the variant row (`FOR SHARE`), then re-compares `state_version`, `variant_version` and `price_version` with the confirmed snapshot. |
| Concurrent selection changes never lose a version | STB-1 | `UPDATE … SET state_version = state_version + 1 … RETURNING` in a single statement. |
| Revocation is visible everywhere at once | REV-1, REV-2 | Grants and their ancestors are read with one recursive query on every request; nothing is cached. |

The order transaction claims rows in a fixed order (idempotency key, then nonce, then session, then variant). Price changes and selection changes each touch a single row, so the lock graph has no cycles.

## Verifying it yourself

```bash
# a PostgreSQL server where your user may CREATE DATABASE
export OICT_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres

npm run test:cluster     # 3 instances, retry storms, lost-update and cross-instance revocation tests
npm run bench:cluster    # 40 shoppers × 15 purchases across 3 instances; fails unless orders == purchases
```

Both create a temporary database and drop it afterwards.

## Keys and tokens

One Ed25519 key signs two kinds of token, and `typ` keeps them apart:

| Token | `typ` | Issued by | Proves |
|---|---|---|---|
| Access token | `at+jwt` | `POST /v1/grants` (or an external authorization server) | The caller is the grant's subject (MPA-7) |
| Confirmation | `oict-confirmation+jwt` | `POST /v1/confirmations` | The consumer confirmed this exact snapshot (STB-5) |

The public half is published at `/.well-known/jwks.json`, so a platform or an auditor can verify any confirmation attached to an order without a shared secret.

**Rotating the key.** Export the current JWK Set, start every instance with the new `OICT_SIGNING_KEY` and `OICT_TRUSTED_JWKS_FILE` pointing at the old set, and remove the old set once its tokens have expired (15 minutes for access tokens, 2 minutes for confirmations by default).

```bash
curl -s https://oict.example/.well-known/jwks.json > previous-jwks.json
OICT_SIGNING_KEY=$(openssl rand -hex 32) OICT_TRUSTED_JWKS_FILE=previous-jwks.json npm start
```

**Using an external authorization server.** Put its Ed25519 public keys in `OICT_TRUSTED_JWKS_FILE`, add its issuer to `OICT_TRUSTED_ISSUERS`, and have it issue `at+jwt` tokens with `aud` = `OICT_AUDIENCE`, `sub` = the grant's subject and a `grant_id` claim.

## Monitoring

**Metrics.** Each instance serves Prometheus metrics at `/metrics`. Scrape every instance:

```yaml
scrape_configs:
  - job_name: oict
    static_configs:
      - targets: ["oict-1:8787", "oict-2:8787"]
```

| Metric | Type | Labels | Use |
|---|---|---|---|
| `oict_http_requests_total` | counter | `method`, `route`, `status` | Traffic and error rates |
| `oict_http_request_duration_seconds` | histogram | `route` | Latency percentiles |
| `oict_orders_total` | counter | `result` = `created` / `replayed` | Orders, and how often clients retry |
| `oict_integrity_refusals_total` | counter | `code` | Every request an OICT rule refused, by reason |
| `oict_build_info` | gauge | `version`, `store`, `instance` | Which version runs where |

`oict_integrity_refusals_total` is the one to alert on. A jump in `STALE_CONFIRMATION` points at a client that is not re-rendering after a price change. A jump in `AGENT_FORBIDDEN` or `UNAUTHENTICATED` points at an agent or integration trying something it should not.

**Logs.** One JSON object per request on stdout, with `requestId`, `instance`, the route template (never raw ids), `status`, `durationMs`, the authenticated `subject`, and the OICT `code` for refusals. Send `X-Request-Id` from the client to follow one purchase across client logs, server logs and audit events.

**Audit trail.** `audit_events` records grants issued and revoked, draft carts, orders, and refused order attempts with the acting participant, the consumer, the reason code, the request id and the instance. The `order.placed` event is written in the same transaction as the order. A trigger rejects every `UPDATE` and `DELETE`, so the table can only grow. An application holding `order:read` for a consumer can read that consumer's trail at `GET /v1/audit`.

## Performance note

Every grant-scoped request now verifies an Ed25519 signature, and every order and refusal writes an audit row. On the single-machine cluster benchmark this raised median order latency from about 120 ms (v0.2) to about 200 ms with three instances, one database and 40 concurrent clients. Correctness was unchanged: 600 purchases, 600 orders, 0 duplicates. These numbers come from one development machine and only indicate relative cost.

## Database driver

The server includes a small PostgreSQL driver ([`src/store/postgres/wire.ts`](../src/store/postgres/wire.ts)) so the runtime keeps zero dependencies. It supports SCRAM-SHA-256, MD5 and cleartext authentication, optional TLS, parameterised queries and pooling. `PostgresStore` only relies on a `query(text, values)` / `connect()` / `release()` interface, the same shape as `pg.Pool` from node-postgres, so a deployment can swap in that driver if it needs features beyond this scope.
