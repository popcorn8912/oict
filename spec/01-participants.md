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

## 1.5 Authentication

Holding a grant identifier is not authority. Every request that acts under a grant authenticates the caller as that grant's subject.

**MPA-7.** Requests that act under a grant **MUST** carry `Authorization: Bearer <access token>`. The access token is a JWT whose claims include `iss`, `sub`, `aud`, `exp`, `iat`, `jti` and `grant_id` (the shape of RFC 9068 plus the grant it acts under), and **MAY** include `scope`. A service **MUST**:

- verify the signature against a key it trusts, and accept tokens only from issuers it trusts;
- require its own identifier in `aud`, and refuse tokens past `exp`;
- refuse the request when `sub` is not the grant's subject;
- treat `scope`, when present, as a further narrowing of the grant's scopes, never a widening.

Failures **MUST** use `UNAUTHENTICATED` (401). A request with no `Authorization` header fails with `UNKNOWN_GRANT` (MPA-1). A bare grant identifier (for example the legacy `OICT-Grant <id>` header) **MUST NOT** be accepted in production.

**MPA-8.** Tokens **MUST** be signed with an asymmetric algorithm; unsigned tokens (`alg: none`) and shared-secret algorithms **MUST** be refused. Every token **MUST** declare its key (`kid`) and its type (`typ`), and a service **MUST** reject a token of the wrong type. An access token (`typ: at+jwt`) can never be used as a consumer confirmation (`typ: oict-confirmation+jwt`), and the reverse.

The reference server signs with Ed25519 (`alg: EdDSA`), returns an access token for the grant's subject from `POST /v1/grants`, and can also accept tokens from an external authorization server whose keys and issuer it is configured to trust. Access tokens are short-lived (15 minutes by default) and independent of the grant's lifetime: a client whose token expires while its grant is still live obtains a new token from its authorization server, and a revoked grant stops a still-valid token immediately (REV-1).
