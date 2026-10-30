import { randomBytes } from "node:crypto";
import { MemoryStore } from "../store/memory.ts";
import type { Store } from "../store/store.ts";
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
  /** Where state lives. Defaults to an in-process MemoryStore. */
  store?: Store;
  /**
   * HMAC secret for confirmation tokens. Every instance that shares a store
   * MUST share this secret. Random per process when omitted.
   */
  secret?: Buffer;
  /** Clock in epoch milliseconds; injectable for deterministic tests. */
  now?: () => number;
  /** Lifetime of a consumer confirmation (spec/02 STB-6). Default 120 s. */
  confirmationTtlSeconds?: number;
  /** Teen orders above this total need guardian consent (spec/04). Default 5000. */
  teenUnassistedLimitMinor?: number;
  /** Seed catalog for a new MemoryStore (ignored when `store` is given). */
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

/**
 * The OICT reference engine: the merchant-side transaction-integrity layer.
 * Rules live here; durable state and the atomicity guarantees that make the
 * rules hold across many instances live in the Store.
 */
export class OictEngine {
  readonly store: Store;
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly confirmationTtlMs: number;
  private readonly teenLimit: number;

  constructor(opts: EngineOptions = {}) {
    this.store = opts.store ?? new MemoryStore(opts.catalog ?? []);
    this.secret = opts.secret ?? randomBytes(32);
    this.now = opts.now ?? Date.now;
    this.confirmationTtlMs = (opts.confirmationTtlSeconds ?? 120) * 1000;
    this.teenLimit = opts.teenUnassistedLimitMinor ?? 5000;
  }

  // ───────────────────────────── participants ─────────────────────────────

  async registerParticipant(p: Participant): Promise<Participant> {
    if (!p.id || !p.kind) throw new OictError("BAD_REQUEST", "participant needs id and kind");
    const kinds = ["platform", "developer", "application", "merchant", "consumer", "agent"];
    if (!kinds.includes(p.kind)) throw new OictError("BAD_REQUEST", `unknown participant kind ${p.kind}`);
    if (p.kind === "application") {
      const platform = p.platformId ? await this.store.getParticipant(p.platformId) : undefined;
      const developer = p.developerId ? await this.store.getParticipant(p.developerId) : undefined;
      if (platform?.kind !== "platform" || developer?.kind !== "developer") {
        throw new OictError("BAD_REQUEST", "an application must reference a registered platformId and developerId");
      }
    }
    if (p.kind === "consumer" && !["under13", "13-17", "adult"].includes(p.ageBand ?? "")) {
      throw new OictError("BAD_REQUEST", "a consumer must declare an ageBand");
    }
    const stored: Participant = {
      id: p.id,
      kind: p.kind,
      ageBand: p.kind === "consumer" ? p.ageBand : undefined,
      displayName: p.displayName,
      platformId: p.kind === "application" ? p.platformId : undefined,
      developerId: p.kind === "application" ? p.developerId : undefined,
    };
    await this.store.insertParticipant(stored);
    return stripUndefined(stored);
  }

  private async participant(id: string): Promise<Participant> {
    const p = await this.store.getParticipant(id);
    if (!p) throw new OictError("UNKNOWN_PARTICIPANT", `unknown participant ${id}`);
    return p;
  }

  // ──────────────────────────────── grants ────────────────────────────────

  async issueGrant(input: IssueGrantInput): Promise<Grant> {
    const issuer = await this.participant(input.issuer);
    const subject = await this.participant(input.subject);
    const app = await this.participant(input.application);
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
    let rootConsumerId = issuer.id;

    if (input.parentGrantId) {
      // DLG-1..5: a delegated grant can only narrow its parent.
      const chain = await this.store.getGrantChain(input.parentGrantId);
      const parent = chain[0];
      if (!parent) throw new OictError("UNKNOWN_GRANT", "parent grant not found");
      if (!this.chainActive(chain)) throw new OictError("GRANT_INACTIVE", "parent grant is not active");
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
      rootConsumerId = chain[chain.length - 1]!.issuer;
    } else if (issuer.kind !== "consumer") {
      // MPA-5: root authority to act for a person comes from that person.
      throw new OictError("DELEGATION_INVALID", "a root grant must be issued by a consumer");
    }

    const consumer = await this.participant(rootConsumerId);
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
    await this.store.insertGrant(grant);
    return stripUndefined(grant);
  }

  /** REV-2/REV-4: revocation cascades; only the issuer or the consumer may revoke. */
  async revokeGrant(grantId: string, by: string): Promise<Grant> {
    const chain = await this.store.getGrantChain(grantId);
    const grant = chain[0];
    if (!grant) throw new OictError("UNKNOWN_GRANT", "grant not found");
    if (by !== grant.issuer && by !== chain[chain.length - 1]!.issuer) {
      throw new OictError("PRINCIPAL_MISMATCH", "only the issuer or the consumer may revoke a grant");
    }
    return stripUndefined((await this.store.revokeGrant(grantId, this.now()))!);
  }

  /** A grant is active only if it and every ancestor is unrevoked and unexpired. */
  private chainActive(chain: Grant[]): boolean {
    const now = this.now();
    if (chain.length === 0) return false;
    // A chain whose last element still has a parent was cut short: treat as inactive.
    if (chain[chain.length - 1]!.parentGrantId) return false;
    return chain.every((g) => g.revokedAt === undefined && g.expiresAt > now);
  }

  async isGrantActive(grantId: string): Promise<boolean> {
    return this.chainActive(await this.store.getGrantChain(grantId));
  }

  private async activeGrant(grantId: string | undefined, scope: Scope): Promise<{ grant: Grant; rootConsumerId: string }> {
    const chain = grantId ? await this.store.getGrantChain(grantId) : [];
    const grant = chain[0];
    if (!grant) throw new OictError("UNKNOWN_GRANT", "missing or unknown grant");
    if (!this.chainActive(chain)) throw new OictError("GRANT_INACTIVE", "grant is revoked or expired");
    if (!grant.scopes.includes(scope)) throw new OictError("SCOPE_INSUFFICIENT", `grant lacks ${scope}`);
    return { grant, rootConsumerId: chain[chain.length - 1]!.issuer };
  }

  private assertGrantCoversSession(grant: Grant, rootConsumerId: string, session: Session): void {
    if (grant.application !== session.applicationId) {
      throw new OictError("APPLICATION_MISMATCH", "grant belongs to a different application");
    }
    if (rootConsumerId !== session.consumerId) {
      throw new OictError("PRINCIPAL_MISMATCH", "grant does not act for this session's consumer");
    }
  }

  // ─────────────────────────────── catalog ────────────────────────────────

  listCatalog(): Promise<CatalogItem[]> {
    return this.store.listCatalog();
  }

  private async variant(sku: string, variantId: string) {
    const v = await this.store.getVariant(sku, variantId);
    if (!v) throw new OictError("UNKNOWN_PRODUCT", `unknown product ${sku}/${variantId}`);
    return v;
  }

  /** Fixture hook: a merchant-side price change. Bumps priceVersion. */
  async setPrice(sku: string, variantId: string, unitPriceMinor: number): Promise<CatalogVariant> {
    if (!Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
      throw new OictError("BAD_REQUEST", "unitPriceMinor must be a non-negative integer");
    }
    const v = await this.store.setPrice(sku, variantId, unitPriceMinor);
    if (!v) throw new OictError("UNKNOWN_PRODUCT", `unknown product ${sku}/${variantId}`);
    return v;
  }

  // ────────────────────────────── sessions ────────────────────────────────

  async createSession(consumerId: string, applicationId: string): Promise<Session> {
    const consumer = await this.participant(consumerId);
    const app = await this.participant(applicationId);
    if (consumer.kind !== "consumer" || app.kind !== "application") {
      throw new OictError("BAD_REQUEST", "a session joins one consumer and one application");
    }
    const session: Session = { id: randomId("ses"), consumerId, applicationId, stateVersion: 0, createdAt: this.now() };
    await this.store.insertSession(session);
    return session;
  }

  async session(id: string): Promise<Session> {
    const s = await this.store.getSession(id);
    if (!s) throw new OictError("UNKNOWN_SESSION", `unknown session ${id}`);
    return s;
  }

  /** STB-1: every change of what the consumer is looking at bumps stateVersion. */
  async updateSelection(
    sessionId: string,
    selection: Selection,
  ): Promise<{ session: Session; snapshot: InteractionSnapshot; snapshotHash: string }> {
    if (!selection?.sceneObjectId || !selection.sku || !selection.variantId) {
      throw new OictError("BAD_REQUEST", "selection needs sceneObjectId, sku and variantId");
    }
    if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 99) {
      throw new OictError("BAD_REQUEST", "quantity must be an integer between 1 and 99");
    }
    await this.variant(selection.sku, selection.variantId);
    const session = await this.store.updateSelection(sessionId, { ...selection });
    if (!session) throw new OictError("UNKNOWN_SESSION", `unknown session ${sessionId}`);
    const snapshot = await this.snapshot(session);
    return { session, snapshot, snapshotHash: digest(snapshot) };
  }

  /** The authoritative, server-side view of the current interaction state. */
  async snapshot(session: Session): Promise<InteractionSnapshot> {
    if (!session.selection) throw new OictError("BAD_REQUEST", "session has no selection yet");
    const { item, variant } = await this.variant(session.selection.sku, session.selection.variantId);
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
  async prepareCart(grantId: string | undefined, sessionId: string, stateVersion: number): Promise<DraftCart> {
    const { grant, rootConsumerId } = await this.activeGrant(grantId, "cart:write");
    const session = await this.session(sessionId);
    this.assertGrantCoversSession(grant, rootConsumerId, session);
    if (stateVersion !== session.stateVersion) {
      throw new OictError("STALE_STATE", `cart prepared against stateVersion ${stateVersion}, current is ${session.stateVersion}`);
    }
    const cart: DraftCart = {
      id: randomId("crt"),
      sessionId,
      preparedBy: grant.subject,
      grantId: grant.id,
      stateVersion,
      snapshotHash: digest(await this.snapshot(session)),
      status: "draft",
      createdAt: this.now(),
    };
    await this.store.insertCart(cart);
    return cart;
  }

  // ───────────────────────────── confirmation ─────────────────────────────

  /**
   * STB-3..STB-6: the consumer confirms *exactly what they saw*. If the snapshot
   * hash their UI rendered differs from the server's current snapshot, the
   * confirmation is refused before it can ever become an order.
   */
  async confirm(input: ConfirmInput): Promise<{ token: string; claims: ConfirmationClaims; snapshot: InteractionSnapshot }> {
    const session = await this.session(input.sessionId);
    const consumer = await this.participant(input.consumerId);
    if (consumer.id !== session.consumerId) {
      throw new OictError("PRINCIPAL_MISMATCH", "only the session's consumer can confirm");
    }
    const snapshot = await this.snapshot(session);
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
      throw new OictError("GUARDIAN_CONSENT_REQUIRED", `teen orders above ${this.teenLimit} minor units need guardian consent`);
    }
  }

  // ──────────────────────────────── orders ────────────────────────────────

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    // IDM-1: no key, no order.
    const key = input.idempotencyKey;
    if (!key || key.length < 8 || key.length > 255) {
      throw new OictError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key (8-255 chars) is required");
    }
    // IDM-2/3: same key + same request = same result; same key + different request = error.
    const fingerprint = digest({ g: input.grantId, s: input.sessionId, t: input.confirmationToken });
    const prior = await this.store.getIdempotency(input.grantId, key);
    if (prior) return this.replay(prior.fingerprint, fingerprint, prior.orderId);

    const { grant, rootConsumerId } = await this.activeGrant(input.grantId, "order:place");
    const placer = await this.participant(grant.subject);
    if (placer.kind === "agent") {
      throw new OictError("AGENT_FORBIDDEN", "agents may prepare carts but never place orders");
    }
    const session = await this.session(input.sessionId);
    this.assertGrantCoversSession(grant, rootConsumerId, session);

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
    // STB-7 (pre-check): the state must still be what the consumer confirmed.
    const snapshot = await this.snapshot(session);
    const currentHash = digest(snapshot);
    if (currentHash !== claims.snapshotHash) {
      throw new OictError("STALE_CONFIRMATION", "state changed after the consumer confirmed");
    }
    if (grant.maxOrderTotalMinor !== undefined && claims.totalMinor > grant.maxOrderTotalMinor) {
      throw new OictError("LIMIT_EXCEEDED", "order total exceeds the grant's limit");
    }
    this.assertMinorPolicy(await this.participant(session.consumerId), claims.totalMinor, claims.guardianConsentRef);

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

    // IDM-2..4 + STB-7 (commit-time re-check), atomically in the store.
    const result = await this.store.commitOrder({
      order,
      nonce: claims.nonce,
      grantId: grant.id,
      idempotencyKey: key,
      fingerprint,
      expect: {
        sessionId: session.id,
        stateVersion: snapshot.stateVersion,
        sku: snapshot.sku,
        variantId: snapshot.variantId,
        variantVersion: snapshot.variantVersion,
        priceVersion: snapshot.priceVersion,
      },
    });
    switch (result.kind) {
      case "created":
        return { order: result.order, replayed: false };
      case "replay":
        return { order: result.order, replayed: true };
      case "key_reused":
        throw new OictError("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was used for a different request");
      case "nonce_consumed":
        throw new OictError("CONFIRMATION_CONSUMED", "this confirmation was already used for an order");
      case "stale":
        throw new OictError("STALE_CONFIRMATION", "state changed after the consumer confirmed");
    }
  }

  private async replay(priorFingerprint: string, fingerprint: string, orderId: string): Promise<PlaceOrderResult> {
    if (priorFingerprint !== fingerprint) {
      throw new OictError("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was used for a different request");
    }
    const order = await this.store.getOrder(orderId);
    if (!order) throw new OictError("NOT_FOUND", "order not found");
    return { order, replayed: true };
  }

  async getOrder(orderId: string, grantId: string | undefined): Promise<Order> {
    const { grant, rootConsumerId } = await this.activeGrant(grantId, "order:read");
    const order = await this.store.getOrder(orderId);
    if (!order || order.applicationId !== grant.application || order.consumerId !== rootConsumerId) {
      throw new OictError("NOT_FOUND", "order not found");
    }
    return order;
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
