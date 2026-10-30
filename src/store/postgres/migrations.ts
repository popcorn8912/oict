import type { Pool } from "./wire.ts";

/**
 * Forward-only schema migrations. Every instance runs `migrate()` on start;
 * a PostgreSQL advisory lock makes concurrent starts safe, so a fleet can
 * roll out without a separate migration job.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "core schema",
    sql: `
      CREATE TABLE participants (
        id            text PRIMARY KEY,
        kind          text NOT NULL CHECK (kind IN ('platform','developer','application','merchant','consumer','agent')),
        age_band      text CHECK (age_band IN ('under13','13-17','adult')),
        display_name  text,
        platform_id   text REFERENCES participants(id),
        developer_id  text REFERENCES participants(id),
        CHECK (kind <> 'consumer' OR age_band IS NOT NULL),
        CHECK (kind <> 'application' OR (platform_id IS NOT NULL AND developer_id IS NOT NULL))
      );

      CREATE TABLE grants (
        id                     text PRIMARY KEY,
        issuer                 text NOT NULL REFERENCES participants(id),
        subject                text NOT NULL REFERENCES participants(id),
        application            text NOT NULL REFERENCES participants(id),
        scopes                 jsonb NOT NULL,
        parent_grant_id        text REFERENCES grants(id),
        issued_at              bigint NOT NULL,
        expires_at             bigint NOT NULL,
        revoked_at             bigint,
        guardian_consent_ref   text,
        max_order_total_minor  bigint CHECK (max_order_total_minor >= 0)
      );
      CREATE INDEX grants_parent_idx ON grants (parent_grant_id);

      CREATE TABLE catalog_items (
        sku       text PRIMARY KEY,
        title     text NOT NULL,
        currency  text NOT NULL CHECK (currency ~ '^[A-Z]{3}$')
      );

      CREATE TABLE catalog_variants (
        sku               text NOT NULL REFERENCES catalog_items(sku) ON DELETE CASCADE,
        variant_id        text NOT NULL,
        label             text NOT NULL,
        variant_version   integer NOT NULL,
        price_version     integer NOT NULL,
        unit_price_minor  bigint NOT NULL CHECK (unit_price_minor >= 0),
        available         boolean NOT NULL,
        PRIMARY KEY (sku, variant_id)
      );

      CREATE TABLE sessions (
        id               text PRIMARY KEY,
        consumer_id      text NOT NULL REFERENCES participants(id),
        application_id   text NOT NULL REFERENCES participants(id),
        state_version    bigint NOT NULL DEFAULT 0,
        scene_object_id  text,
        sku              text,
        variant_id       text,
        quantity         integer CHECK (quantity BETWEEN 1 AND 99),
        created_at       bigint NOT NULL
      );

      CREATE TABLE draft_carts (
        id             text PRIMARY KEY,
        session_id     text NOT NULL REFERENCES sessions(id),
        prepared_by    text NOT NULL REFERENCES participants(id),
        grant_id       text NOT NULL REFERENCES grants(id),
        state_version  bigint NOT NULL,
        snapshot_hash  text NOT NULL,
        created_at     bigint NOT NULL
      );

      CREATE TABLE orders (
        id              text PRIMARY KEY,
        session_id      text NOT NULL REFERENCES sessions(id),
        consumer_id     text NOT NULL REFERENCES participants(id),
        application_id  text NOT NULL REFERENCES participants(id),
        placed_by       text NOT NULL REFERENCES participants(id),
        grant_id        text NOT NULL REFERENCES grants(id),
        snapshot        jsonb NOT NULL,
        snapshot_hash   text NOT NULL,
        total_minor     bigint NOT NULL,
        currency        text NOT NULL,
        created_at      bigint NOT NULL
      );
      CREATE INDEX orders_session_idx ON orders (session_id);

      -- IDM-4: one confirmation, one order. The primary key is the guarantee.
      CREATE TABLE consumed_confirmations (
        nonce        text PRIMARY KEY,
        order_id     text NOT NULL REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
        consumed_at  timestamptz NOT NULL DEFAULT now()
      );

      -- IDM-2/IDM-3: keys are scoped to the grant.
      CREATE TABLE idempotency_keys (
        grant_id         text NOT NULL,
        idempotency_key  text NOT NULL,
        fingerprint      text NOT NULL,
        order_id         text NOT NULL REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (grant_id, idempotency_key)
      );
      CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
    `,
  },
];

const LOCK_KEY = 0x01c7; // arbitrary, stable advisory-lock id for OICT migrations

export async function migrate(pool: Pool): Promise<number[]> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS oict_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: number }>("SELECT version FROM oict_schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        for (const stmt of splitStatements(m.sql)) await client.query(stmt);
        await client.query("INSERT INTO oict_schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
        await client.query("COMMIT");
        applied.push(m.version);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

/** The extended-query protocol runs one statement per Parse; split on top-level semicolons. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
