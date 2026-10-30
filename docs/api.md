# Reference API

All bodies are JSON. Errors follow the [error envelope](../spec/05-idempotency-and-errors.md#53-error-envelope). Requests that act under a grant send `Authorization: OICT-Grant <grantId>` (a local-testing simplification — see [spec/01 §1.5](../spec/01-participants.md#15-transport-binding-reference-server)).

| Method | Path | Grant scope | Purpose | Rules |
|---|---|---|---|---|
| `GET` | `/healthz` | — | Liveness, version, store (`memory` / `postgres`) and instance id | — |
| `GET` | `/v1/catalog` | — | Synthetic catalog | — |
| `POST` | `/v1/participants` | — | Register a platform, developer, application, consumer or agent | MPA-6 |
| `POST` | `/v1/grants` | — | Issue a root or delegated grant | MPA-5, DLG-1..5, AGT-1, AGT-5, MIN-1 |
| `POST` | `/v1/grants/:id/revoke` | — | Revoke a grant (cascades) | REV-1..4 |
| `POST` | `/v1/sessions` | — | Open a consumer × application session | — |
| `GET` | `/v1/sessions/:id` | — | Current snapshot and hash | STB-2 |
| `POST` | `/v1/sessions/:id/selection` | — | Report what the consumer is looking at | STB-1 |
| `POST` | `/v1/carts` | `cart:write` | Agent/app drafts a cart at a state version | AGT-2, AGT-3 |
| `POST` | `/v1/confirmations` | — | Consumer confirms a snapshot hash | STB-3..6, MIN-2 |
| `POST` | `/v1/orders` | `order:place` | Exchange a confirmation for an order; needs `Idempotency-Key` | IDM-1..4, STB-7, STB-8 |
| `GET` | `/v1/orders/:id` | `order:read` | Read an order | — |

Every response carries `X-OICT-Version` and `X-OICT-Instance`. Configuration and multi-instance operation: [deployment.md](deployment.md).

### Fixture hooks (conformance only)

Enabled with `OICT_TEST_HOOKS=1`. A service under test must expose equivalents.

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/v1/_test/reset` | — | Drop all state |
| `POST` | `/v1/_test/clock` | `{ "advanceSeconds": 600 }` | Move the service clock forward |
| `POST` | `/v1/_test/price` | `{ "sku", "variantId", "unitPriceMinor" }` | Change a price (bumps `priceVersion`) |
