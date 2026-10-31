import type { AuditEvent, CatalogItem, CatalogVariant, DraftCart, Grant, Order, Participant, Selection, Session } from "../core/types.ts";
import type { CommitOrderInput, CommitOrderResult, IdempotencyRecord, Store } from "./store.ts";

/**
 * In-process store. Every method finishes its reads and writes without
 * yielding, so each one is atomic within a single Node.js process. It is the
 * default for tests, demos and single-instance development; use
 * PostgresStore whenever more than one instance serves traffic.
 */
export class MemoryStore implements Store {
  readonly kind = "memory";
  private participants = new Map<string, Participant>();
  private grants = new Map<string, Grant>();
  private catalog = new Map<string, CatalogItem>();
  private sessions = new Map<string, Session>();
  private carts = new Map<string, DraftCart>();
  private orders = new Map<string, Order>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private nonces = new Set<string>();
  private audit: AuditEvent[] = [];

  constructor(catalog: CatalogItem[] = []) {
    this.seed(catalog);
  }

  private seed(catalog: CatalogItem[]) {
    this.catalog = new Map(catalog.map((c) => [c.sku, structuredClone(c)]));
  }

  async getParticipant(id: string) {
    const p = this.participants.get(id);
    return p && { ...p };
  }
  async insertParticipant(p: Participant) {
    this.participants.set(p.id, { ...p });
  }

  async getGrant(id: string) {
    const g = this.grants.get(id);
    return g && structuredClone(g);
  }
  async getGrantChain(id: string) {
    const chain: Grant[] = [];
    let g = this.grants.get(id);
    while (g && chain.length < 64) {
      chain.push(structuredClone(g));
      g = g.parentGrantId ? this.grants.get(g.parentGrantId) : undefined;
    }
    return chain;
  }
  async insertGrant(g: Grant) {
    this.grants.set(g.id, structuredClone(g));
  }
  async revokeGrant(id: string, at: number) {
    const g = this.grants.get(id);
    if (!g) return undefined;
    g.revokedAt ??= at;
    return structuredClone(g);
  }

  async listCatalog() {
    return [...this.catalog.values()].map((c) => structuredClone(c));
  }
  async getVariant(sku: string, variantId: string) {
    const item = this.catalog.get(sku);
    const variant = item?.variants.find((v) => v.variantId === variantId);
    if (!item || !variant) return undefined;
    return { item: { sku: item.sku, title: item.title, currency: item.currency }, variant: { ...variant } };
  }
  async setPrice(sku: string, variantId: string, unitPriceMinor: number) {
    const v = this.catalog.get(sku)?.variants.find((x) => x.variantId === variantId);
    if (!v) return undefined;
    if (v.unitPriceMinor !== unitPriceMinor) {
      v.unitPriceMinor = unitPriceMinor;
      v.priceVersion += 1;
    }
    return { ...v };
  }

  async insertSession(s: Session) {
    this.sessions.set(s.id, structuredClone(s));
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s && structuredClone(s);
  }
  async updateSelection(id: string, selection: Selection) {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    s.selection = { ...selection };
    s.stateVersion += 1;
    return structuredClone(s);
  }

  async insertCart(c: DraftCart) {
    this.carts.set(c.id, { ...c });
  }

  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o && structuredClone(o);
  }
  async getIdempotency(grantId: string, key: string) {
    const r = this.idempotency.get(`${grantId}\u0000${key}`);
    return r && { ...r };
  }

  async commitOrder(input: CommitOrderInput): Promise<CommitOrderResult> {
    const idemKey = `${input.grantId}\u0000${input.idempotencyKey}`;
    const prior = this.idempotency.get(idemKey);
    if (prior) {
      if (prior.fingerprint !== input.fingerprint) return { kind: "key_reused" };
      return { kind: "replay", order: structuredClone(this.orders.get(prior.orderId)!) };
    }
    if (this.nonces.has(input.nonce)) return { kind: "nonce_consumed" };

    const e = input.expect;
    const s = this.sessions.get(e.sessionId);
    const v = this.catalog.get(e.sku)?.variants.find((x) => x.variantId === e.variantId);
    if (
      !s || !v ||
      s.stateVersion !== e.stateVersion ||
      s.selection?.sku !== e.sku || s.selection?.variantId !== e.variantId ||
      v.variantVersion !== e.variantVersion || v.priceVersion !== e.priceVersion
    ) {
      return { kind: "stale" };
    }

    this.nonces.add(input.nonce);
    this.orders.set(input.order.id, structuredClone(input.order));
    this.idempotency.set(idemKey, { fingerprint: input.fingerprint, orderId: input.order.id });
    this.audit.push(structuredClone(input.audit));
    return { kind: "created", order: structuredClone(input.order) };
  }

  async appendAudit(e: AuditEvent) {
    this.audit.push(structuredClone(e));
  }

  async listAudit(q: { consumerId: string; applicationId: string; limit: number }) {
    const out: AuditEvent[] = [];
    for (let i = this.audit.length - 1; i >= 0 && out.length < q.limit; i--) {
      const e = this.audit[i]!;
      if (e.consumerId === q.consumerId && e.applicationId === q.applicationId) out.push(structuredClone(e));
    }
    return out;
  }

  async reset(catalog: CatalogItem[]) {
    this.participants.clear();
    this.grants.clear();
    this.sessions.clear();
    this.carts.clear();
    this.orders.clear();
    this.idempotency.clear();
    this.nonces.clear();
    this.audit = [];
    this.seed(catalog);
  }

  async close() {}
}
