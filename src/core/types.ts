/**
 * OICT core types.
 *
 * Everything here is protocol-neutral: OICT sits *on top of* an existing
 * checkout protocol (UCP, ACP, or a platform commerce API) and only adds
 * multi-party authorization, interaction-state binding and agent controls.
 */

export type ParticipantKind =
  | "platform"
  | "developer"
  | "application"
  | "merchant"
  | "consumer"
  | "agent";

/** Age bands used by the minor-protection profile (spec/04). */
export type AgeBand = "under13" | "13-17" | "adult";

export interface Participant {
  id: string;
  kind: ParticipantKind;
  /** Only meaningful for consumers. */
  ageBand?: AgeBand;
  displayName?: string;
  /** Applications only: the platform the application runs on. */
  platformId?: string;
  /** Applications only: the developer who publishes the application. */
  developerId?: string;
}

export type Scope =
  | "catalog:read"
  | "cart:write"
  | "checkout:prepare"
  | "order:place"
  | "order:read";

export const ALL_SCOPES: readonly Scope[] = [
  "catalog:read",
  "cart:write",
  "checkout:prepare",
  "order:place",
  "order:read",
];

/** Scopes that an agent may never hold (spec/03 AGT-1). */
export const AGENT_FORBIDDEN_SCOPES: readonly Scope[] = ["order:place"];

export interface Grant {
  id: string;
  /** Who granted the authority (a consumer, or the subject of the parent grant). */
  issuer: string;
  /** Who holds the authority. */
  subject: string;
  /** The immersive application the authority is confined to. */
  application: string;
  scopes: Scope[];
  parentGrantId?: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  /** Opaque reference to a verifiable guardian consent record (spec/04). */
  guardianConsentRef?: string;
  /** Upper bound on a single order placed under this grant, in minor units. */
  maxOrderTotalMinor?: number;
}

export interface CatalogItem {
  sku: string;
  title: string;
  currency: string;
  variants: CatalogVariant[];
}

export interface CatalogVariant {
  variantId: string;
  label: string;
  /** Bumped whenever the variant's attributes change. */
  variantVersion: number;
  /** Bumped whenever the price changes. */
  priceVersion: number;
  unitPriceMinor: number;
  available: boolean;
}

/** What the consumer is looking at *right now* inside the experience. */
export interface Selection {
  sceneObjectId: string;
  sku: string;
  variantId: string;
  quantity: number;
}

export interface InteractionSnapshot {
  sessionId: string;
  stateVersion: number;
  sceneObjectId: string;
  sku: string;
  variantId: string;
  variantVersion: number;
  priceVersion: number;
  unitPriceMinor: number;
  currency: string;
  quantity: number;
}

export interface Session {
  id: string;
  consumerId: string;
  applicationId: string;
  stateVersion: number;
  selection?: Selection;
  createdAt: number;
}

export interface ConfirmationClaims {
  /** Token version. */
  v: 1;
  /** Issuer of the confirmation (the merchant service). */
  iss: string;
  sessionId: string;
  consumerId: string;
  snapshotHash: string;
  stateVersion: number;
  totalMinor: number;
  currency: string;
  guardianConsentRef?: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface Order {
  id: string;
  sessionId: string;
  consumerId: string;
  applicationId: string;
  placedBy: string;
  grantId: string;
  snapshot: InteractionSnapshot;
  snapshotHash: string;
  totalMinor: number;
  currency: string;
  createdAt: number;
}

export interface DraftCart {
  id: string;
  sessionId: string;
  preparedBy: string;
  grantId: string;
  stateVersion: number;
  snapshotHash: string;
  status: "draft";
  createdAt: number;
}

/** Stable, machine-readable error codes (spec/05). */
export type OictErrorCode =
  | "BAD_REQUEST"
  | "UNKNOWN_PARTICIPANT"
  | "UNKNOWN_GRANT"
  | "UNKNOWN_SESSION"
  | "UNKNOWN_PRODUCT"
  | "GRANT_INACTIVE"
  | "SCOPE_INSUFFICIENT"
  | "DELEGATION_INVALID"
  | "APPLICATION_MISMATCH"
  | "PRINCIPAL_MISMATCH"
  | "AGENT_FORBIDDEN"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CONFIRMATION_INVALID"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_CONSUMED"
  | "STALE_CONFIRMATION"
  | "STALE_STATE"
  | "MINOR_RESTRICTED"
  | "GUARDIAN_CONSENT_REQUIRED"
  | "LIMIT_EXCEEDED"
  | "UNAUTHENTICATED"
  | "NOT_FOUND";

export const ERROR_STATUS: Record<OictErrorCode, number> = {
  BAD_REQUEST: 400,
  UNKNOWN_PARTICIPANT: 404,
  UNKNOWN_GRANT: 401,
  UNKNOWN_SESSION: 404,
  UNKNOWN_PRODUCT: 404,
  GRANT_INACTIVE: 401,
  SCOPE_INSUFFICIENT: 403,
  DELEGATION_INVALID: 422,
  APPLICATION_MISMATCH: 403,
  PRINCIPAL_MISMATCH: 403,
  AGENT_FORBIDDEN: 403,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  CONFIRMATION_INVALID: 401,
  CONFIRMATION_EXPIRED: 409,
  CONFIRMATION_CONSUMED: 409,
  STALE_CONFIRMATION: 409,
  STALE_STATE: 409,
  MINOR_RESTRICTED: 403,
  GUARDIAN_CONSENT_REQUIRED: 403,
  LIMIT_EXCEEDED: 403,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
};

export class OictError extends Error {
  readonly code: OictErrorCode;
  readonly status: number;
  constructor(code: OictErrorCode, message: string) {
    super(message);
    this.name = "OictError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** Claims of an OICT access token (RFC 9068 shape plus the grant it carries). */
export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  jti: string;
  client_id?: string;
  scope?: string;
  grant_id: string;
}

/** Who is calling, as established by authentication. */
export interface Caller {
  grantId: string;
  /** Authenticated principal; must equal the grant's subject when present. */
  subject?: string;
  /** Scopes carried by the access token; when present they further narrow the grant. */
  scopes?: string[];
}

export type AuditType = "grant.issued" | "grant.revoked" | "cart.prepared" | "order.placed" | "order.refused";

/** One append-only audit record: who did what, on whose behalf. */
export interface AuditEvent {
  id: string;
  at: number;
  type: AuditType;
  /** Participant that acted (consumer, application or agent). */
  actor?: string;
  /** Consumer on whose behalf the action happened. */
  consumerId?: string;
  applicationId?: string;
  grantId?: string;
  sessionId?: string;
  orderId?: string;
  /** OICT error code for refusals. */
  code?: string;
  detail?: Record<string, unknown>;
  instance?: string;
  requestId?: string;
}
