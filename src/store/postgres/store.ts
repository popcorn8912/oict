import type { CatalogItem, CatalogVariant, DraftCart, Grant, Order, Participant, Scope, Selection, Session } from "../../core/types.ts";
import type { CommitOrderInput, CommitOrderResult, IdempotencyRecord, Store } from "../store.ts";
import { migrate } from "./migrations.ts";
import { Pool, type PoolClient, type Queryable } from "./wire.ts";

type Row = Record<string, any>;

const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

function toParticipant(r: Row): Participant {
  return {
    id: r.id,
    kind: r.kind,
    ageBand: str(r.age_band) as Participant["ageBand"],
    displayName: str(r.display_name),
    platformId: str(r.platform_id),
    developerId: str(r.developer_id),
  };
}

function toGrant(r: Row): Grant {
  return {
    id: r.id,
    issuer: r.issuer,
    subject: r.subject,
    application: r.application,
    scopes: r.scopes as Scope[],
    parentGrantId: str(r.parent_grant_id),
    issuedAt: Number(r.issued_at),
    expiresAt: Number(r.expires_at),
    revokedAt: num(r.revoked_at),
    guardianConsentRef: str(r.guardian_consent_ref),
    maxOrderTotalMinor: num(r.max_order_total_minor),
  };
}

function toVariant(r: Row): CatalogVariant {
  return {
    variantId: r.variant_id,
    label: r.label,
    variantVersion: Number(r.variant_version),
    priceVersion: Number(r.price_version),
    unitPriceMinor: Number(r.unit_price_minor),
    available: Boolean(r.available),
  };
}

function toSession(r: Row): Session {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    applicationId: r.application_id,
    stateVersion: Number(r.state_version),
    selection: r.sku
      ? { sceneObjectId: r.scene_object_id, sku: r.sku, variantId: r.variant_id, quantity: Number(r.quantity) }
      : undefined,
    createdAt: Number(r.created_at),
  };
}

function toOrder(r: Row): Order {
  return {
    id: r.id,
    sessionId: r.session_id,
    consumerId: r.consumer_id,
    applicationId: r.application_id,
    placedBy: r.placed_by,
    grantId: r.grant_id,
    snapshot: r.snapshot,
    snapshotHash: r.snapshot_hash,
    totalMinor: Number(r.total_minor),
    currency: r.currency,
    createdAt: Number(r.created_at),
  };
}

export interface PostgresStoreOptions {
  /** Max pooled connections per instance. Default 10. */
  poolSize?: number;
}

/**
 * PostgreSQL-backed store. Safe to share between any number of OICT
 * instances: every invariant that matters for money is enforced by the
 * database (row locks, primary keys, a single transaction per order), not by
 * process memory.
 */
export class PostgresStore implements Store {
  readonly kind = "postgres";
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async connect(url: string, catalog: CatalogItem[], opts: PostgresStoreOptions = {}): Promise<PostgresStore> {
    const pool = new Pool(url, { max: opts.poolSize ?? 10 });
    await migrate(pool);
    const store = new PostgresStore(pool);
    await store.seedCatalog(pool, catalog);
    return store;
  }

  private async seedCatalog(q: Queryable, catalog: CatalogItem[]) {
    for (const item of catalog) {
      await q.query<Row>("INSERT INTO catalog_items (sku, title, currency) VALUES ($1, $2, $3) ON CONFLICT (sku) DO NOTHING", [
        item.sku,
        item.title,
        item.currency,
      ]);
      for (const v of item.variants) {
        await q.query<Row>(
          `INSERT INTO catalog_variants (sku, variant_id, label, variant_version, price_version, unit_price_minor, available)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (sku, variant_id) DO NOTHING`,
          [item.sku, v.variantId, v.label, v.variantVersion, v.priceVersion, v.unitPriceMinor, v.available],
        );
      }
    }
  }

  // ───────────────────────────── participants ─────────────────────────────

  async getParticipant(id: string) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM participants WHERE id = $1", [id]);
    return rows[0] ? toParticipant(rows[0]) : undefined;
  }

  async insertParticipant(p: Participant) {
    await this.pool.query<Row>(
      `INSERT INTO participants (id, kind, age_band, display_name, platform_id, developer_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, age_band = EXCLUDED.age_band,
         display_name = EXCLUDED.display_name, platform_id = EXCLUDED.platform_id, developer_id = EXCLUDED.developer_id`,
      [p.id, p.kind, p.ageBand ?? null, p.displayName ?? null, p.platformId ?? null, p.developerId ?? null],
    );
  }

  // ──────────────────────────────── grants ────────────────────────────────

  async getGrant(id: string) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM grants WHERE id = $1", [id]);
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  async getGrantChain(id: string) {
    const { rows } = await this.pool.query<Row>(
      `WITH RECURSIVE chain AS (
         SELECT g.*, 0 AS depth FROM grants g WHERE g.id = $1
         UNION ALL
         SELECT p.*, c.depth + 1 FROM grants p JOIN chain c ON p.id = c.parent_grant_id WHERE c.depth < 64
       )
       SELECT * FROM chain ORDER BY depth`,
      [id],
    );
    return rows.map(toGrant);
  }

  async insertGrant(g: Grant) {
    await this.pool.query<Row>(
      `INSERT INTO grants (id, issuer, subject, application, scopes, parent_grant_id, issued_at, expires_at,
                           revoked_at, guardian_consent_ref, max_order_total_minor)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        g.id, g.issuer, g.subject, g.application, JSON.stringify(g.scopes), g.parentGrantId ?? null,
        g.issuedAt, g.expiresAt, g.revokedAt ?? null, g.guardianConsentRef ?? null, g.maxOrderTotalMinor ?? null,
      ],
    );
  }

  async revokeGrant(id: string, at: number) {
    const { rows } = await this.pool.query<Row>(
      "UPDATE grants SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1 RETURNING *",
      [id, at],
    );
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  // ─────────────────────────────── catalog ────────────────────────────────

  async listCatalog() {
    const { rows } = await this.pool.query<Row>(
      `SELECT i.sku, i.title, i.currency, v.variant_id, v.label, v.variant_version, v.price_version, v.unit_price_minor, v.available
       FROM catalog_items i JOIN catalog_variants v ON v.sku = i.sku ORDER BY i.sku, v.variant_id`,
    );
    const items = new Map<string, CatalogItem>();
    for (const r of rows) {
      if (!items.has(r.sku)) items.set(r.sku, { sku: r.sku, title: r.title, currency: r.currency, variants: [] });
      items.get(r.sku)!.variants.push(toVariant(r));
    }
    return [...items.values()];
  }

  async getVariant(sku: string, variantId: string) {
    const { rows } = await this.pool.query<Row>(
      `SELECT i.sku, i.title, i.currency, v.* FROM catalog_variants v JOIN catalog_items i ON i.sku = v.sku
       WHERE v.sku = $1 AND v.variant_id = $2`,
      [sku, variantId],
    );
    const r = rows[0];
    return r ? { item: { sku: r.sku, title: r.title, currency: r.currency }, variant: toVariant(r) } : undefined;
  }

  async setPrice(sku: string, variantId: string, unitPriceMinor: number) {
    // Right-hand sides see the pre-update row, so the version bumps only on a real change.
    const { rows } = await this.pool.query<Row>(
      `UPDATE catalog_variants
         SET price_version = price_version + CASE WHEN unit_price_minor <> $3 THEN 1 ELSE 0 END,
             unit_price_minor = $3
       WHERE sku = $1 AND variant_id = $2 RETURNING *`,
      [sku, variantId, unitPriceMinor],
    );
    return rows[0] ? toVariant(rows[0]) : undefined;
  }

  // ────────────────────────────── sessions ────────────────────────────────

  async insertSession(s: Session) {
    await this.pool.query<Row>(
      "INSERT INTO sessions (id, consumer_id, application_id, state_version, created_at) VALUES ($1, $2, $3, $4, $5)",
      [s.id, s.consumerId, s.applicationId, s.stateVersion, s.createdAt],
    );
  }

  async getSession(id: string) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM sessions WHERE id = $1", [id]);
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async updateSelection(id: string, sel: Selection) {
    // One statement: the row lock makes concurrent updates serialize, so no version is ever lost.
    const { rows } = await this.pool.query<Row>(
      `UPDATE sessions
         SET scene_object_id = $2, sku = $3, variant_id = $4, quantity = $5, state_version = state_version + 1
       WHERE id = $1 RETURNING *`,
      [id, sel.sceneObjectId, sel.sku, sel.variantId, sel.quantity],
    );
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  // ─────────────────────────────── carts ──────────────────────────────────

  async insertCart(c: DraftCart) {
    await this.pool.query<Row>(
      `INSERT INTO draft_carts (id, session_id, prepared_by, grant_id, state_version, snapshot_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.id, c.sessionId, c.preparedBy, c.grantId, c.stateVersion, c.snapshotHash, c.createdAt],
    );
  }

  // ─────────────────────────────── orders ─────────────────────────────────

  async getOrder(id: string) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM orders WHERE id = $1", [id]);
    return rows[0] ? toOrder(rows[0]) : undefined;
  }

  async getIdempotency(grantId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const { rows } = await this.pool.query<Row>(
      "SELECT fingerprint, order_id FROM idempotency_keys WHERE grant_id = $1 AND idempotency_key = $2",
      [grantId, key],
    );
    return rows[0] ? { fingerprint: rows[0].fingerprint, orderId: rows[0].order_id } : undefined;
  }

  /**
   * One transaction, three guarantees:
   *   1. the idempotency key row is claimed first — concurrent requests with the
   *      same key queue on the primary key and then replay the winner's order;
   *   2. the confirmation nonce row is claimed next — any other request carrying
   *      the same confirmation, whatever its key, finds it taken (IDM-4);
   *   3. the session and variant rows are locked and re-checked against the
   *      versions the consumer confirmed (STB-7) before the order is written.
   */
  async commitOrder(input: CommitOrderInput): Promise<CommitOrderResult> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const outcome = await this.commitInTx(client, input);
      if (outcome.kind === "created") await client.query("COMMIT");
      else await client.query("ROLLBACK");

      if (outcome.kind === "idem_conflict") {
        const prior = await this.getIdempotency(input.grantId, input.idempotencyKey);
        if (!prior) return { kind: "nonce_consumed" };
        if (prior.fingerprint !== input.fingerprint) return { kind: "key_reused" };
        const order = await this.getOrder(prior.orderId);
        return order ? { kind: "replay", order } : { kind: "nonce_consumed" };
      }
      return outcome;
    } catch (e) {
      broken = true;
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release(broken ? new Error("transaction aborted") : undefined);
    }
  }

  private async commitInTx(
    c: PoolClient,
    input: CommitOrderInput,
  ): Promise<CommitOrderResult | { kind: "idem_conflict" }> {
    const o = input.order;
    const e = input.expect;

    const idem = await c.query<Row>(
      `INSERT INTO idempotency_keys (grant_id, idempotency_key, fingerprint, order_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1`,
      [input.grantId, input.idempotencyKey, input.fingerprint, o.id],
    );
    if (idem.rowCount === 0) return { kind: "idem_conflict" };

    const nonce = await c.query<Row>(
      "INSERT INTO consumed_confirmations (nonce, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1",
      [input.nonce, o.id],
    );
    if (nonce.rowCount === 0) return { kind: "nonce_consumed" };

    const s = await c.query<Row>("SELECT state_version, sku, variant_id FROM sessions WHERE id = $1 FOR UPDATE", [e.sessionId]);
    const v = await c.query<Row>(
      "SELECT variant_version, price_version FROM catalog_variants WHERE sku = $1 AND variant_id = $2 FOR SHARE",
      [e.sku, e.variantId],
    );
    const sr = s.rows[0], vr = v.rows[0];
    if (
      !sr || !vr ||
      Number(sr.state_version) !== e.stateVersion || sr.sku !== e.sku || sr.variant_id !== e.variantId ||
      Number(vr.variant_version) !== e.variantVersion || Number(vr.price_version) !== e.priceVersion
    ) {
      return { kind: "stale" };
    }

    await c.query<Row>(
      `INSERT INTO orders (id, session_id, consumer_id, application_id, placed_by, grant_id, snapshot, snapshot_hash,
                           total_minor, currency, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      [o.id, o.sessionId, o.consumerId, o.applicationId, o.placedBy, o.grantId, JSON.stringify(o.snapshot),
        o.snapshotHash, o.totalMinor, o.currency, o.createdAt],
    );
    return { kind: "created", order: o };
  }

  // ─────────────────────────────── admin ──────────────────────────────────

  async reset(catalog: CatalogItem[]) {
    await this.pool.query<Row>(
      `TRUNCATE idempotency_keys, consumed_confirmations, orders, draft_carts, sessions, grants, participants,
                catalog_variants, catalog_items RESTART IDENTITY CASCADE`,
    );
    await this.seedCatalog(this.pool, catalog);
  }

  /** Count orders for a session — used by the multi-instance tests. */
  async countOrders(sessionId?: string): Promise<number> {
    const { rows } = sessionId
      ? await this.pool.query<Row>("SELECT count(*)::int AS n FROM orders WHERE session_id = $1", [sessionId])
      : await this.pool.query<Row>("SELECT count(*)::int AS n FROM orders");
    return Number(rows[0]!.n);
  }

  async close() {
    await this.pool.end();
  }
}
