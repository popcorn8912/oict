import type { AuditEvent, CatalogItem, CatalogVariant, DraftCart, Grant, Order, Participant, Selection, Session } from "../core/types.ts";

/**
 * Versions the order must still match at the instant it is committed (STB-7).
 * A store compares them under a lock / inside one transaction, so a price
 * change or selection change that lands between the engine's pre-check and
 * the commit can never slip through.
 */
export interface CommitExpectation {
  sessionId: string;
  stateVersion: number;
  sku: string;
  variantId: string;
  variantVersion: number;
  priceVersion: number;
}

export interface CommitOrderInput {
  order: Order;
  /** Confirmation nonce; may buy exactly once (IDM-4). */
  nonce: string;
  grantId: string;
  idempotencyKey: string;
  /** Digest of the request; same key + different fingerprint = IDEMPOTENCY_KEY_REUSED (IDM-3). */
  fingerprint: string;
  expect: CommitExpectation;
  /** Written in the same transaction as the order, so the trail can never miss an order. */
  audit: AuditEvent;
}

export type CommitOrderResult =
  | { kind: "created"; order: Order }
  | { kind: "replay"; order: Order }
  | { kind: "key_reused" }
  | { kind: "nonce_consumed" }
  | { kind: "stale" };

export interface IdempotencyRecord {
  fingerprint: string;
  orderId: string;
}

/**
 * Everything the engine needs to persist. Implementations MUST make
 * `updateSelection`, `setPrice`, `revokeGrant` and `commitOrder` atomic with
 * respect to every other instance sharing the store.
 */
export interface Store {
  readonly kind: string;

  getParticipant(id: string): Promise<Participant | undefined>;
  insertParticipant(p: Participant): Promise<void>;

  getGrant(id: string): Promise<Grant | undefined>;
  /** The grant followed by every ancestor, nearest first. */
  getGrantChain(id: string): Promise<Grant[]>;
  insertGrant(g: Grant): Promise<void>;
  /** Sets revokedAt if not already set; returns the stored grant. */
  revokeGrant(id: string, at: number): Promise<Grant | undefined>;

  listCatalog(): Promise<CatalogItem[]>;
  getVariant(sku: string, variantId: string): Promise<{ item: Omit<CatalogItem, "variants">; variant: CatalogVariant } | undefined>;
  /** Atomically sets a price, bumping priceVersion when it changes. */
  setPrice(sku: string, variantId: string, unitPriceMinor: number): Promise<CatalogVariant | undefined>;

  insertSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  /** Atomically stores the selection and increments stateVersion (no lost updates). */
  updateSelection(id: string, selection: Selection): Promise<Session | undefined>;

  insertCart(c: DraftCart): Promise<void>;

  getOrder(id: string): Promise<Order | undefined>;
  getIdempotency(grantId: string, key: string): Promise<IdempotencyRecord | undefined>;
  commitOrder(input: CommitOrderInput): Promise<CommitOrderResult>;

  /** Append-only: implementations MUST NOT offer update or delete. */
  appendAudit(e: AuditEvent): Promise<void>;
  /** Newest first. */
  listAudit(q: { consumerId: string; applicationId: string; limit: number }): Promise<AuditEvent[]>;

  /** Test hook: drop all state and reseed the catalog. */
  reset(catalog: CatalogItem[]): Promise<void>;
  close(): Promise<void>;
}
