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
| `OICT_SECRET` | with a database | Key that signs consumer confirmations: at least 32 bytes as hex (64 characters) or base64. **Every instance must use the same value**, or a confirmation issued by one instance is rejected by the others. |
| `OICT_DB_POOL_SIZE` | no | Connections per instance (default 10). |
| `OICT_INSTANCE_ID` | no | Name shown in `/healthz` and the `X-OICT-Instance` response header. |
| `PORT` | no | Listen port (default 8787). |
| `OICT_TEST_HOOKS` | no | `1` exposes `/v1/_test/*` fixture endpoints. Never enable in production. |

```bash
export OICT_DATABASE_URL=postgres://oict:oict@localhost:5432/oict
export OICT_SECRET=$(openssl rand -hex 32)
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

## Database driver

The server includes a small PostgreSQL driver ([`src/store/postgres/wire.ts`](../src/store/postgres/wire.ts)) so the runtime keeps zero dependencies. It supports SCRAM-SHA-256, MD5 and cleartext authentication, optional TLS, parameterised queries and pooling. `PostgresStore` only relies on a `query(text, values)` / `connect()` / `release()` interface, the same shape as `pg.Pool` from node-postgres, so a deployment can swap in that driver if it needs features beyond this scope.
