# 05 · Idempotency & Errors

## 5.1 Why two layers of duplicate protection

Network timeouts in immersive clients are common (mobile devices, VR headsets on Wi-Fi, game loops that drop frames). A client that times out will retry — and a surprising number of clients *regenerate their request identifier* on retry, which defeats key-based idempotency alone. OICT therefore protects against duplicates twice:

1. **Idempotency keys** make a retry of the *same request* safe.
2. **Single-use confirmations** make it impossible for *any* request — whatever key the client invents — to turn one consumer confirmation into two orders.

## 5.2 Rules

**IDM-1.** `POST /orders` **MUST** carry an `Idempotency-Key` header of 8–255 characters. Requests without one fail with `IDEMPOTENCY_KEY_REQUIRED`.

**IDM-2.** Keys are scoped to the grant. A repeated request with the same key and the same body **MUST** return the original result and **MUST NOT** create a second order. The reference server answers `200` with header `OICT-Idempotent-Replay: true`. Concurrent duplicates **MUST** also yield exactly one order.

**IDM-3.** A request that reuses a key with a *different* body **MUST** fail with `IDEMPOTENCY_KEY_REUSED`.

**IDM-4.** A confirmation token's `nonce` **MUST** be consumed when an order is created. Any later order request carrying the same confirmation **MUST** fail with `CONFIRMATION_CONSUMED`, regardless of its idempotency key.

Implementations **SHOULD** retain idempotency records for at least 24 hours. The reference server stores only successful results, so a request that failed validation may be retried with the same key after the cause is fixed.

## 5.3 Error envelope

**ERR-1.** Every error response **MUST** be JSON of the form:

```json
{ "error": { "code": "STALE_CONFIRMATION", "message": "state changed after the consumer confirmed" } }
```

`code` is one of the stable values below; `message` is human-readable and not stable.

**ERR-2.** A malformed request body **MUST** produce `400 BAD_REQUEST`, never a `5xx`.

| Code | HTTP | Raised by |
|---|---:|---|
| `BAD_REQUEST` | 400 | malformed input, ERR-2, MPA-6 |
| `UNKNOWN_GRANT` | 401 | MPA-1 |
| `UNAUTHENTICATED` | 401 | MPA-7, MPA-8 |
| `GRANT_INACTIVE` | 401 | REV-1, REV-2, REV-3 |
| `SCOPE_INSUFFICIENT` | 403 | MPA-2, AGT-1 |
| `APPLICATION_MISMATCH` | 403 | MPA-3 |
| `PRINCIPAL_MISMATCH` | 403 | MPA-4, REV-4 |
| `AGENT_FORBIDDEN` | 403 | AGT-1 |
| `MINOR_RESTRICTED` | 403 | MIN-1 |
| `GUARDIAN_CONSENT_REQUIRED` | 403 | MIN-2, AGT-5 |
| `LIMIT_EXCEEDED` | 403 | DLG-5 |
| `UNKNOWN_PARTICIPANT` / `UNKNOWN_SESSION` / `UNKNOWN_PRODUCT` / `NOT_FOUND` | 404 | — |
| `STALE_CONFIRMATION` | 409 | STB-3, STB-7 |
| `STALE_STATE` | 409 | AGT-3 |
| `CONFIRMATION_EXPIRED` | 409 | STB-6 |
| `CONFIRMATION_CONSUMED` | 409 | IDM-4 |
| `CONFIRMATION_INVALID` | 401 | STB-5 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | IDM-1 |
| `IDEMPOTENCY_KEY_REUSED` | 422 | IDM-3 |
| `DELEGATION_INVALID` | 422 | DLG-1..4, MPA-5 |
