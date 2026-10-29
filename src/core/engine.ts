import { randomBytes } from "node:crypto";
import { digest, randomId, signToken, verifyToken } from "./crypto.ts";
import {
  AGENT_FORBIDDEN_SCOPES,
  ALL_SCOPES,
  OictError,
  type CatalogItem,
  type CatalogVariant,
  type ConfirmationClaims,
  type DraftCart,
  type Grant,
  type InteractionSnapshot,
  type Order,
  type Participant,
  type Scope,
  type Selection,
  type Session,
} from "./types.ts";

export interface EngineOptions {
  /** HMAC secret for confirmation tokens. Random per process by default. */
  secret?: Buffer;
  /** Clock in epoch milliseconds; injectable for deterministic tests. */
  now?: () => number;
  /** Lifetime of a consumer confirmation (spec/02 STB-6). Default 120 s. */
  confirmationTtlSeconds?: number;
  /** Teen orders above this total need guardian consent (spec/04). Default 5000. */
  teenUnassistedLimitMinor?: number;
  catalog?: CatalogItem[];
}

export interface IssueGrantInput {
  issuer: string;
  subject: string;
  application: string;
  scopes: Scope[];
  ttlSeconds: number;
  parentGrantId?: string;
  guardianConsentRef?: string;
  maxOrderTotalMinor?: number;
}

export interface ConfirmInput {
  sessionId: string;
  consumerId: string;
  /** The snapshot hash the consumer's UI was rendering when they pressed "buy". */
  snapshotHash: string;
  guardianConsentRef?: string;
}

export interface PlaceOrderInput {
  grantId: string;
  idempotencyKey?: string;
  sessionId: string;
  confirmationToken: string;
}

export interface PlaceOrderResult {
  order: Order;
  /** True when this call replayed an earlier result for the same idempotency key. */
  replayed: boolean;
}

interface IdempotencyRecord {
  fingerprint: string;
  result: Order;
}

/**
 * The OICT reference engine: the merchant-side transaction-integrity layer.
 * It holds all state in memory; a production deployment would back each map
 * with durable storage and keep the same rules.
 */
export class OictEngine {
  readonly participants = new Map<string, Participant>();
  readonly grants = new Map<string, Grant>();
  readonly sessions = new Map<string, Session>();
  readonly orders = new Map<string, Order>();
  readonly carts = new Map<string, DraftCart>();
  private readonly catalog = new Map<string, CatalogItem>();
  private readonly consumedNonces = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly confirmationTtlMs: number;
  private readonly teenLimit: number;

  constructor(opts: EngineOptions = {}) {
    this.secret = opts.secret ?? randomBytes(32);
    this.now = opts.now ?? Date.now;
    this.confirmationTtlMs = (opts.confirmationTtlSeconds ?? 120) * 1000;
    this.teenLimit = opts.teenUnassistedLimitMinor ?? 5000;
    for (const item of opts.catalog ?? []) this.catalog.set(item.sku, structuredClone(item));
  }

  // ───────────────────────────── participants ─────────────────────────────

  registerParticipant(p: Participant): Participant {
    if (!p.id || !p.kind) throw new OictError("BAD_REQUEST", "participant needs id and kind");
    if (p.kind === "application") {
      const platform = p.platformId ? this.participants.get(p.platformId) : undefined;
      const developer = p.developerId ? this.participants.get(p.developerId) : undefined;
      if (platform?.kind !== "platform" || developer?.kind !== "developer") {
        throw new OictError(
          "BAD_REQUEST",
          "an application must reference a registered platformId and developerId",
        );
      }
    }
    if (p.kind === "consumer" && !p.ageBand) {
      throw new OictError("BAD_REQUEST", "a consumer must declare an ageBand");
    }
    const stored = { ...p };
    this.participants.set(p.id, stored);
    return stored;
  }

  private participant(id: string): Participant {
    const p = this.participants.get(id);
    if (!p) throw new OictError("UNKNOWN_PARTICIPANT", `unknown participant ${id}`);
    return p;
  }

  // ──────────────────────────────── grants ────────────────────────────────

  issueGrant(input: IssueGrantInput): Grant {
    const issuer = this.participant(input.issuer);
    const subject = this.participant(input.subject);
    const app = this.participant(input.application);
    if (app.kind !== "application") {
      throw new OictError("BAD_REQUEST", "grant.application must be an application");
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new OictError("BAD_REQUEST", "grant.scopes must be a non-empty array");
    }
    for (const s of input.scopes) {
      if (!ALL_SCOPES.includes(s)) throw new OictError("BAD_REQUEST", `unknown scope ${s}`);
    }
    if (!(input.ttlSeconds > 0)) throw new OictError("BAD_REQUEST", "ttlSeconds must be > 0");

    // AGT-1: agents prepare, people decide.
    if (subject.kind === "agent" && input.scopes.some((s) => AGENT_FORBIDDEN_SCOPES.includes(s))) {
      throw new OictError("AGENT_FORBIDDEN", "an agent may not hold order:place");
    }

    const now = this.now();
    let expiresAt = now + input.ttlSeconds * 1000;
    let guardianConsentRef = input.guardianConsentRef;
    let maxOrderTotalMinor = input.maxOrderTotalMinor;

    if (input.parentGrantId) {
      // DLG-1..5: a delegated grant can only narrow its parent.
      const parent = this.grants.get(input.parentGrantId);
      if (!parent) throw new OictError("UNKNOWN_GRANT", "parent grant not found");
      if (!this.isGrantActive(parent)) throw new OictError("GRANT_INACTIVE", "parent grant is not active");
      if (parent.subject !== issuer.id) {
        throw new OictError("DELEGATION_INVALID", "only the parent grant's subject may delegate it");
      }
      if (parent.application !== app.id) {
        throw new OictError("DELEGATION_INVALID", "a delegated grant must stay within the same application");
      }
      const extra = input.scopes.filter((s) => !parent.scopes.includes(s));
      if (extra.length) {
        throw new OictError("DELEGATION_INVALID", `scopes exceed parent grant: ${extra.join(", ")}`);
      }
      if (expiresAt > parent.expiresAt) {
        throw new OictError("DELEGATION_INVALID", "a delegated grant may not outlive its parent");
      }
      guardianConsentRef = guardianConsentRef ?? parent.guardianConsentRef;
      if (parent.maxOrderTotalMinor !== undefined) {
        maxOrderTotalMinor = Math.min(maxOrderTotalMinor ?? Infinity, parent.maxOrderTotalMinor);
      }
      expiresAt = Math.min(expiresAt, parent.expiresAt);
    } else if (issuer.kind !== "consumer") {
      // MPA-5: root authority to act for a person comes from that person.
      throw new OictError("DELEGATION_INVALID", "a root grant must be issued by a consumer");
    }

    const consumer = this.participant(this.rootConsumerId({ issuer: issuer.id, parentGrantId: input.parentGrantId }));
    const purchaseScopes = input.scopes.some((s) => s === "cart:write" || s === "order:place");
    if (purchaseScopes && consumer.ageBand === "under13") {
      throw new OictError("MINOR_RESTRICTED", "consumers under 13 cannot authorize physical-goods purchases");
    }
    if (subject.kind === "agent" && consumer.ageBand === "13-17" && !guardianConsentRef) {
      throw new OictError("GUARDIAN_CONSENT_REQUIRED", "an agent acting for a teen requires guardian consent");
    }

    const grant: Grant = {
      id: randomId("grt"),
      issuer: issuer.id,
      subject: subject.id,
      application: app.id,
      scopes: [...input.scopes],
      parentGrantId: input.parentGrantId,
      issuedAt: now,
      expiresAt,
      guardianConsentRef,
      maxOrderTotalMinor,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /** REV-2/REV-4: revocation cascades; only the issuer or the consumer may revoke. */
  revokeGrant(grantId: string, by: string): Grant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new OictError("UNKNOWN_GRANT", "grant not found");
    if (by !== grant.issuer && by !== this.rootConsumerId(grant)) {
      throw new OictError("PRINCIPAL_MISMATCH", "only the issuer or the consumer may revoke a grant");
    }
    grant.revokedAt ??= this.now();
    return grant;
  }

  isGrantActive(grant: Grant): boolean {
    const now = this.now();
    let g: Grant | undefined = grant;
    while (g) {
      if (g.revokedAt !== undefined || g.expiresAt <= now) return false;
      g = g.parentGrantId ? this.grants.get(g.parentGrantId) : undefined;
    }
    return true;
  }

  rootConsumerId(grant: Pick<Grant, "issuer" | "parentGrantId">): string {
    let issuer = grant.issuer;
    let parentId = grant.parentGrantId;
    while (parentId) {
      const parent = this.grants.get(parentId);
      if (!parent) break;
      issuer = parent.issuer;
      parentId = parent.parentGrantId;
    }
    return issuer;
  }

  private activeGrant(grantId: string | undefined, scope: Scope): Grant {
    const grant = grantId ? this.grants.get(grantId) : undefined;
    if (!grant) throw new OictError("UNKNOWN_GRANT", "missing or unknown grant");
    if (!this.isGrantActive(grant)) throw new OictError("GRANT_INACTIVE", "grant is revoked or expired");
    if (!grant.scopes.includes(scope)) throw new OictError("SCOPE_INSUFFICIENT", `grant lacks ${scope}`);
    return grant;
  }

  private assertGrantCoversSession(grant: Grant, session: Session): void {
    if (grant.application !== session.applicationId) {
      throw new OictError("APPLICATION_MISMATCH", "grant belongs to a different application");
    }
    if (this.rootConsumerId(grant) !== session.consumerId) {
      throw new OictError("PRINCIPAL_MISMATCH", "grant does not act for this session's consumer");
    }
  }

  // ─────────────────────────────── catalog ────────────────────────────────

  listCatalog(): CatalogItem[] {
    return [...this.catalog.values()].map((c) => structuredClone(c));
  }

  private variant(sku: string, variantId: string): { item: CatalogItem; variant: CatalogVariant } {
    const item = this.catalog.get(sku);
    const variant = item?.variants.find((v) => v.variantId === variantId);
    if (!item || !variant) throw new OictError("UNKNOWN_PRODUCT", `unknown product ${sku}/${variantId}`);
    return { item, variant };
  }

  /** Fixture hook: a merchant-side price change. Bumps priceVersion. */
  setPrice(sku: string, variantId: string, unitPriceMinor: number): CatalogVariant {
    const { variant } = this.variant(sku, variantId);
    if (variant.unitPriceMinor !== unitPriceMinor) {
      variant.unitPriceMinor = unitPriceMinor;
      variant.priceVersion += 1;
    }
    return { ...variant };
  }

  // ────────────────────────────── sessions ────────────────────────────────

  createSession(consumerId: string, applicationId: string): Session {
    const consumer = this.participant(consumerId);
    const app = this.participant(applicationId);
    if (consumer.kind !== "consumer" || app.kind !== "application") {
      throw new OictError("BAD_REQUEST", "a session joins one consumer and one application");
    }
    const session: Session = {
      id: randomId("ses"),
      consumerId,
      applicationId,
      stateVersion: 0,
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new OictError("UNKNOWN_SESSION", `unknown session ${id}`);
    return s;
  }

  /** STB-1: every change of what the consumer is looking at bumps stateVersion. */
  updateSelection(sessionId: string, selection: Selection): { session: Session; snapshot: InteractionSnapshot; snapshotHash: string } {
    const session = this.session(sessionId);
    if (!selection?.sceneObjectId || !selection.sku || !selection.variantId) {
      throw new OictError("BAD_REQUEST", "selection needs sceneObjectId, sku and variantId");
    }
    if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 99) {
      throw new OictError("BAD_REQUEST", "quantity must be an integer between 1 and 99");
    }
    this.variant(selection.sku, selection.variantId);
    session.selection = { ...selection };
    session.stateVersion += 1;
    const snapshot = this.snapshot(session);
    return { session, snapshot, snapshotHash: digest(snapshot) };
  }

  /** The authoritative, server-side view of the current interaction state. */
  snapshot(session: Session): InteractionSnapshot {
    if (!session.selection) throw new OictError("BAD_REQUEST", "session has no selection yet");
    const { item, variant } = this.variant(session.selection.sku, session.selection.variantId);
    return {
      sessionId: session.id,
      stateVersion: session.stateVersion,
      sceneObjectId: session.selection.sceneObjectId,
      sku: item.sku,
      variantId: variant.variantId,
      variantVersion: variant.variantVersion,
      priceVersion: variant.priceVersion,
      unitPriceMinor: variant.unitPriceMinor,
      currency: item.currency,
      quantity: session.selection.quantity,
    };
  }

  // ───────────────────────────── agent carts ──────────────────────────────

  /** AGT-2/AGT-3: an agent may draft a cart, bound to the state version it saw. */
  prepareCart(grantId: string | undefined, sessionId: string, stateVersion: number): DraftCart {
    const grant = this.activeGrant(grantId, "cart:write");
    const session = this.session(sessionId);
    this.assertGrantCoversSession(grant, session);
    if (stateVersion !== session.stateVersion) {
      throw new OictError(
        "STALE_STATE",
        `cart prepared against stateVersion ${stateVersion}, current is ${session.stateVersion}`,
      );
    }
    const snapshot = this.snapshot(session);
    const cart: DraftCart = {
      id: randomId("crt"),
      sessionId,
      preparedBy: grant.subject,
      grantId: grant.id,
      stateVersion,
      snapshotHash: digest(snapshot),
      status: "draft",
      createdAt: this.now(),
    };
    this.carts.set(cart.id, cart);
    return cart;
  }

  // ───────────────────────────── confirmation ─────────────────────────────

  /**
   * STB-3..STB-6: the consumer confirms *exactly what they saw*. If the snapshot
   * hash their UI rendered differs from the server's current snapshot, the
   * confirmation is refused before it can ever become an order.
   */
  confirm(input: ConfirmInput): { token: string; claims: ConfirmationClaims; snapshot: InteractionSnapshot } {
    const session = this.session(input.sessionId);
    const consumer = this.participant(input.consumerId);
    if (consumer.id !== session.consumerId) {
      throw new OictError("PRINCIPAL_MISMATCH", "only the session's consumer can confirm");
    }
    const snapshot = this.snapshot(session);
    const currentHash = digest(snapshot);
    if (input.snapshotHash !== currentHash) {
      throw new OictError("STALE_CONFIRMATION", "the confirmed view no longer matches the current state");
    }
    const total = snapshot.unitPriceMinor * snapshot.quantity;
    this.assertMinorPolicy(consumer, total, input.guardianConsentRef);

    const iat = this.now();
    const claims: ConfirmationClaims = {
      v: 1,
      sessionId: session.id,
      consumerId: consumer.id,
      snapshotHash: currentHash,
      stateVersion: session.stateVersion,
      totalMinor: total,
      currency: snapshot.currency,
      guardianConsentRef: input.guardianConsentRef,
      iat,
      exp: iat + this.confirmationTtlMs,
      nonce: randomBytes(12).toString("base64url"),
    };
    return { token: signToken(claims, this.secret), claims, snapshot };
  }

  private assertMinorPolicy(consumer: Participant, totalMinor: number, guardianConsentRef?: string): void {
    if (consumer.ageBand === "under13") {
      throw new OictError("MINOR_RESTRICTED", "consumers under 13 cannot purchase physical goods");
    }
    if (consumer.ageBand === "13-17" && totalMinor > this.teenLimit && !guardianConsentRef) {
      throw new OictError(
        "GUARDIAN_CONSENT_REQUIRED",
        `teen orders above ${this.teenLimit} minor units need guardian consent`,
      );
    }
  }

  // ──────────────────────────────── orders ────────────────────────────────

  placeOrder(input: PlaceOrderInput): PlaceOrderResult {
    // IDM-1: no key, no order.
    if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255) {
      throw new OictError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key (8-255 chars) is required");
    }
    // IDM-2/3: same key + same request = same result; same key + different request = error.
    const idemKey = `${input.grantId}\u0000${input.idempotencyKey}`;
    const fingerprint = digest({ g: input.grantId, s: input.sessionId, t: input.confirmationToken });
    const prior = this.idempotency.get(idemKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new OictError("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was used for a different request");
      }
      return { order: prior.result, replayed: true };
    }

    const grant = this.activeGrant(input.grantId, "order:place");
    const placer = this.participant(grant.subject);
    if (placer.kind === "agent") {
      throw new OictError("AGENT_FORBIDDEN", "agents may prepare carts but never place orders");
    }
    const session = this.session(input.sessionId);
    this.assertGrantCoversSession(grant, session);

    const claims = verifyToken<ConfirmationClaims>(input.confirmationToken ?? "", this.secret);
    if (!claims || claims.v !== 1 || claims.sessionId !== session.id) {
      throw new OictError("CONFIRMATION_INVALID", "confirmation token is malformed, forged or for another session");
    }
    if (claims.consumerId !== session.consumerId) {
      throw new OictError("PRINCIPAL_MISMATCH", "confirmation was given by a different consumer");
    }
    if (claims.exp <= this.now()) {
      throw new OictError("CONFIRMATION_EXPIRED", "confirmation expired; ask the consumer to confirm again");
    }
    // IDM-4: a confirmation buys exactly once, whatever key the client invents on retry.
    if (this.consumedNonces.has(claims.nonce)) {
      throw new OictError("CONFIRMATION_CONSUMED", "this confirmation was already used for an order");
    }
    // STB-7: re-check the state at the moment of placement.
    const snapshot = this.snapshot(session);
    const currentHash = digest(snapshot);
    if (currentHash !== claims.snapshotHash) {
      throw new OictError("STALE_CONFIRMATION", "state changed after the consumer confirmed");
    }
    if (grant.maxOrderTotalMinor !== undefined && claims.totalMinor > grant.maxOrderTotalMinor) {
      throw new OictError("LIMIT_EXCEEDED", "order total exceeds the grant's limit");
    }
    this.assertMinorPolicy(this.participant(session.consumerId), claims.totalMinor, claims.guardianConsentRef);

    const order: Order = {
      id: randomId("ord"),
      sessionId: session.id,
      consumerId: session.consumerId,
      applicationId: session.applicationId,
      placedBy: grant.subject,
      grantId: grant.id,
      snapshot,
      snapshotHash: currentHash,
      totalMinor: claims.totalMinor,
      currency: claims.currency,
      createdAt: this.now(),
    };
    this.consumedNonces.add(claims.nonce);
    this.orders.set(order.id, order);
    this.idempotency.set(idemKey, { fingerprint, result: order });
    return { order, replayed: false };
  }

  getOrder(orderId: string, grantId: string | undefined): Order {
    const grant = this.activeGrant(grantId, "order:read");
    const order = this.orders.get(orderId);
    if (!order || order.applicationId !== grant.application || order.consumerId !== this.rootConsumerId(grant)) {
      throw new OictError("NOT_FOUND", "order not found");
    }
    return order;
  }
}
