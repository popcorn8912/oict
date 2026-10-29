# 01 · Participants, Grants & Delegation

## 1.1 Participant registry

A merchant's transaction service keeps a registry of participants. Each participant has a stable `id` and a `kind` (`platform`, `developer`, `application`, `merchant`, `consumer`, `agent`). See [`schemas/participant.schema.json`](../schemas/participant.schema.json).

**MPA-6.** An `application` participant **MUST** reference a registered `platformId` and a registered `developerId`. A service **MUST** reject an application whose platform or developer of record is unknown. This gives every transaction an accountable chain: *which platform, which developer, which experience*.

A `consumer` participant **MUST** declare an `ageBand` (see [04](04-minor-protection.md)).

## 1.2 Grants

A **grant** is a scoped, time-boxed statement of authority: *issuer* lets *subject* perform *scopes* inside one *application*. See [`schemas/grant.schema.json`](../schemas/grant.schema.json).

| Scope | Allows |
|---|---|
| `catalog:read` | Read products and prices. |
| `cart:write` | Prepare a draft cart bound to a state version. |
| `checkout:prepare` | Request totals, shipping options and other pre-order data from the underlying protocol. |
| `order:place` | Exchange a consumer confirmation for an order. |
| `order:read` | Read orders placed for this consumer in this application. |

**MPA-1.** Every request that creates a cart or an order **MUST** carry a grant. Requests without a grant **MUST** fail with `UNKNOWN_GRANT`.

**MPA-2.** A grant authorizes only the scopes it lists. A request outside them **MUST** fail with `SCOPE_INSUFFICIENT`.

**MPA-3.** A grant is confined to one application. Using it on a session that belongs to another application **MUST** fail with `APPLICATION_MISMATCH`.

**MPA-4.** A grant acts for exactly one consumer: the issuer at the root of its delegation chain. Using it on another consumer's session **MUST** fail with `PRINCIPAL_MISMATCH`.

**MPA-5.** A root grant (one with no parent) **MUST** be issued by a consumer. Platforms, developers, applications and agents hold purchase authority only because a consumer delegated it.

## 1.3 Delegation

A grant **MAY** name a `parentGrantId`. Delegation lets an application hand a narrow slice of its authority to an agent, or to a short-lived sub-component of itself.

**DLG-1.** The scopes of a delegated grant **MUST** be a subset of its parent's scopes.

**DLG-2.** A delegated grant **MUST NOT** expire after its parent.

**DLG-3.** Only the *subject* of the parent grant **MAY** issue a delegated grant from it.

**DLG-4.** A delegated grant **MUST** stay within the parent's application.

**DLG-5.** Constraints are inherited and can only tighten: a child's `maxOrderTotalMinor` is the minimum of its own and its parent's; a parent's `guardianConsentRef` carries over. An order whose total exceeds the effective limit **MUST** fail with `LIMIT_EXCEEDED`.

Violations of DLG-1 to DLG-4 **MUST** fail with `DELEGATION_INVALID`.

## 1.4 Revocation & expiry

**REV-1.** A revoked grant **MUST** be unusable immediately, including for requests whose confirmation was issued before the revocation. Failure code: `GRANT_INACTIVE`.

**REV-2.** Revocation **MUST** cascade: a grant is active only if every grant in its parent chain is active.

**REV-3.** A grant past its `expiresAt` **MUST** be treated as inactive.

**REV-4.** Only a grant's issuer, or the consumer at the root of its chain, **MAY** revoke it. Other callers **MUST** receive `PRINCIPAL_MISMATCH`.

## 1.5 Transport binding (reference server)

The reference server identifies the grant with `Authorization: OICT-Grant <grantId>`. This is a deliberate simplification for local testing. A production deployment **SHOULD** carry the grant inside an OAuth 2.0 access token (for example as a `grant_id` claim of a JWT access token, or via token introspection) and **MUST** authenticate the caller as the grant's subject.
