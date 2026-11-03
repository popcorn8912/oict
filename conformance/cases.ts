import { createPublicKey, verify } from "node:crypto";
import { auth, check, confirm, expectError, idem, must, newKey, order, setCart, tokenFor, world, type Client } from "./client.ts";

const HOODIE = { sku: "SYN-HOODIE-01", variantId: "violet-m" } as const; // 42.00 USD
const LAMP = { sku: "SYN-LAMP-03", variantId: "std" } as const; // 29.00 USD
const POSTER_EUR = { sku: "SYN-POSTER-EU", variantId: "a2" } as const; // 19.00 EUR

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

export type Category = "AUTH" | "DLG" | "REV" | "IDM" | "STB" | "AGT" | "MIN" | "ERR";

export interface Case {
  id: string;
  category: Category;
  /** Spec rule(s) this case verifies. */
  rule: string;
  title: string;
  run: (c: Client) => Promise<void>;
}

export const CATEGORY_TITLES: Record<Category, string> = {
  AUTH: "Multi-party authorization",
  DLG: "Delegation",
  REV: "Revocation & expiry",
  IDM: "Idempotency & duplicate purchase",
  STB: "State–order binding",
  AGT: "AI agent controls",
  MIN: "Minor protection",
  ERR: "Error envelope",
};

const ALL = ["catalog:read", "cart:write", "checkout:prepare", "order:place", "order:read"];

export const CASES: Case[] = [
  // ─────────────────────────────── AUTH ───────────────────────────────
  {
    id: "OICT-AUTH-001", category: "AUTH", rule: "MPA-1", title: "order without a grant is rejected",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await expectError(c.post("/v1/orders", { sessionId: w.sessionId, confirmationToken: t }, idem(newKey())), "UNKNOWN_GRANT", 401);
    },
  },
  {
    id: "OICT-AUTH-002", category: "AUTH", rule: "MPA-2", title: "grant without order:place cannot order",
    async run(c) {
      const w = await world(c, { appScopes: ["catalog:read", "cart:write"] });
      await expectError(order(w, await confirm(w)), "SCOPE_INSUFFICIENT", 403);
    },
  },
  {
    id: "OICT-AUTH-003", category: "AUTH", rule: "MPA-3", title: "grant for another application is rejected",
    async run(c) {
      const w = await world(c);
      const g = await must(c.post("/v1/grants", { issuer: "alice", subject: "app2", application: "app2", scopes: ALL, ttlSeconds: 600 }), 201);
      await expectError(order(w, await confirm(w), newKey(), g.body.id), "APPLICATION_MISMATCH", 403);
    },
  },
  {
    id: "OICT-AUTH-004", category: "AUTH", rule: "MPA-4", title: "grant acting for a different consumer is rejected",
    async run(c) {
      const w = await world(c);
      const g = await must(c.post("/v1/grants", { issuer: "bob", subject: "app", application: "app", scopes: ALL, ttlSeconds: 600 }), 201);
      await expectError(order(w, await confirm(w), newKey(), g.body.id), "PRINCIPAL_MISMATCH", 403);
    },
  },
  {
    id: "OICT-AUTH-005", category: "AUTH", rule: "MPA-5", title: "root grants must come from the consumer",
    async run(c) {
      await world(c);
      await expectError(c.post("/v1/grants", { issuer: "dev", subject: "app", application: "app", scopes: ALL, ttlSeconds: 600 }), "DELEGATION_INVALID");
    },
  },
  {
    id: "OICT-AUTH-006", category: "AUTH", rule: "MPA-6", title: "applications must name a registered platform and developer",
    async run(c) {
      await world(c);
      await expectError(c.post("/v1/participants", { id: "rogue", kind: "application", platformId: "nope", developerId: "dev" }), "BAD_REQUEST", 400);
    },
  },
  {
    id: "OICT-AUTH-007", category: "AUTH", rule: "MPA-7", title: "knowing a grant id is not enough to use it",
    async run(c) {
      const w = await world(c);
      check(tokenFor(w.appGrant), "POST /v1/grants must return an accessToken for the grant's subject");
      const t = await confirm(w);
      await expectError(
        c.post("/v1/orders", { sessionId: w.sessionId, confirmationToken: t }, { authorization: `OICT-Grant ${w.appGrant}`, ...idem(newKey()) }),
        "UNAUTHENTICATED",
        401,
      );
    },
  },
  {
    id: "OICT-AUTH-008", category: "AUTH", rule: "MPA-7", title: "an altered access token is rejected",
    async run(c) {
      const w = await world(c);
      const [h, p, s] = tokenFor(w.appGrant)!.split(".");
      const claims = b64json(p!);
      claims.scope = "catalog:read cart:write checkout:prepare order:place order:read";
      claims.exp += 86400;
      const forged = `${h}.${b64(claims)}.${s}`;
      await expectError(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, bearer(forged)), "UNAUTHENTICATED", 401);
    },
  },
  {
    id: "OICT-AUTH-009", category: "AUTH", rule: "MPA-7", title: "an expired access token is rejected while the grant lives on",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await must(c.post("/v1/_test/clock", { advanceSeconds: 3000 }), 200);
      // Grant lives 3600 s; the access token is short-lived and has expired.
      await expectError(c.post("/v1/orders", { sessionId: w.sessionId, confirmationToken: t }, { ...auth(w.appGrant), ...idem(newKey()) }), "UNAUTHENTICATED", 401);
    },
  },
  {
    id: "OICT-AUTH-010", category: "AUTH", rule: "MPA-8", title: "an unsigned (alg: none) access token is rejected",
    async run(c) {
      const w = await world(c);
      const [h, p] = tokenFor(w.appGrant)!.split(".");
      const header = { ...b64json(h!), alg: "none" };
      await expectError(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, bearer(`${b64(header)}.${p}.`)), "UNAUTHENTICATED", 401);
    },
  },
  {
    id: "OICT-AUTH-011", category: "AUTH", rule: "MPA-8", title: "a confirmation token cannot be used as an access token",
    async run(c) {
      const w = await world(c);
      await expectError(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, bearer(await confirm(w))), "UNAUTHENTICATED", 401);
    },
  },

  // ─────────────────────────────── DLG ────────────────────────────────
  {
    id: "OICT-DLG-001", category: "DLG", rule: "DLG-1", title: "delegated grant cannot add scopes",
    async run(c) {
      const w = await world(c, { appScopes: ["catalog:read", "cart:write"] });
      await expectError(
        c.post("/v1/grants", { issuer: "app", subject: "helper", application: "app", scopes: ["cart:write", "order:read"], ttlSeconds: 60, parentGrantId: w.appGrant }),
        "DELEGATION_INVALID",
      );
    },
  },
  {
    id: "OICT-DLG-002", category: "DLG", rule: "DLG-2", title: "delegated grant cannot outlive its parent",
    async run(c) {
      const w = await world(c);
      await expectError(
        c.post("/v1/grants", { issuer: "app", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 999_999, parentGrantId: w.appGrant }),
        "DELEGATION_INVALID",
      );
    },
  },
  {
    id: "OICT-DLG-003", category: "DLG", rule: "DLG-3", title: "only the parent grant's subject may delegate",
    async run(c) {
      const w = await world(c);
      await expectError(
        c.post("/v1/grants", { issuer: "dev", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60, parentGrantId: w.appGrant }),
        "DELEGATION_INVALID",
      );
    },
  },
  {
    id: "OICT-DLG-004", category: "DLG", rule: "DLG-4", title: "delegation stays inside one application",
    async run(c) {
      const w = await world(c);
      await expectError(
        c.post("/v1/grants", { issuer: "app", subject: "helper", application: "app2", scopes: ["cart:write"], ttlSeconds: 60, parentGrantId: w.appGrant }),
        "DELEGATION_INVALID",
      );
    },
  },
  {
    id: "OICT-DLG-005", category: "DLG", rule: "DLG-5", title: "spending limit is inherited and enforced",
    async run(c) {
      const w = await world(c);
      const capped = await must(c.post("/v1/grants", { issuer: "alice", subject: "app", application: "app", scopes: ALL, ttlSeconds: 600, maxOrderTotalMinor: 1000 }), 201);
      const child = await must(
        c.post("/v1/grants", { issuer: "app", subject: "app", application: "app", scopes: ["order:place"], ttlSeconds: 60, parentGrantId: capped.body.id }),
        201,
      );
      check(child.body.maxOrderTotalMinor === 1000, "child grant did not inherit maxOrderTotalMinor");
      await expectError(order(w, await confirm(w), newKey(), child.body.id), "LIMIT_EXCEEDED", 403);
    },
  },
  {
    id: "OICT-DLG-006", category: "DLG", rule: "DLG-5, STB-10", title: "a spending limit applies to the whole cart, not each line",
    async run(c) {
      const w = await world(c);
      const capped = await must(c.post("/v1/grants", { issuer: "alice", subject: "app", application: "app", scopes: ALL, ttlSeconds: 600, maxOrderTotalMinor: 5000 }), 201);
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 1 }]); // 42 + 29, each under the cap
      await expectError(order(w, await confirm(w), newKey(), capped.body.id), "LIMIT_EXCEEDED", 403);
    },
  },

  // ─────────────────────────────── REV ────────────────────────────────
  {
    id: "OICT-REV-001", category: "REV", rule: "REV-1", title: "revoked grant cannot place an order",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await must(c.post(`/v1/grants/${w.appGrant}/revoke`, { by: "alice" }), 200);
      await expectError(order(w, t), "GRANT_INACTIVE", 401);
    },
  },
  {
    id: "OICT-REV-002", category: "REV", rule: "REV-2", title: "revocation cascades to delegated grants",
    async run(c) {
      const w = await world(c);
      const child = await must(
        c.post("/v1/grants", { issuer: "app", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60, parentGrantId: w.appGrant }),
        201,
      );
      await must(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, auth(child.body.id)), 201);
      await must(c.post(`/v1/grants/${w.appGrant}/revoke`, { by: "alice" }), 200);
      await expectError(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, auth(child.body.id)), "GRANT_INACTIVE");
    },
  },
  {
    id: "OICT-REV-003", category: "REV", rule: "REV-3", title: "expired grant is rejected",
    async run(c) {
      const w = await world(c);
      const short = await must(c.post("/v1/grants", { issuer: "alice", subject: "app", application: "app", scopes: ALL, ttlSeconds: 30 }), 201);
      const t = await confirm(w);
      await must(c.post("/v1/_test/clock", { advanceSeconds: 31 }), 200);
      await expectError(order(w, t, newKey(), short.body.id), "GRANT_INACTIVE");
    },
  },
  {
    id: "OICT-REV-004", category: "REV", rule: "REV-4", title: "third parties cannot revoke someone else's grant",
    async run(c) {
      const w = await world(c);
      await expectError(c.post(`/v1/grants/${w.appGrant}/revoke`, { by: "bob" }), "PRINCIPAL_MISMATCH", 403);
    },
  },
  {
    id: "OICT-REV-005", category: "REV", rule: "REV-5", title: "withdrawing order:place stops purchases but keeps order history",
    async run(c) {
      const w = await world(c);
      const placed = await must(order(w, await confirm(w)), 201);
      const r = await must(c.post(`/v1/grants/${w.appGrant}/revoke`, { by: "alice", scopes: ["order:place"] }), 200);
      check(!r.body.scopes.includes("order:place") && r.body.scopes.includes("order:read"), "grant should keep its other scopes");
      await expectError(order(w, await confirm(w)), "SCOPE_INSUFFICIENT", 403);
      await must(c.get(`/v1/orders/${placed.body.id}`, auth(w.appGrant)), 200);
    },
  },
  {
    id: "OICT-REV-006", category: "REV", rule: "REV-5", title: "narrowing a grant narrows every grant delegated from it",
    async run(c) {
      const w = await world(c);
      const child = await must(
        c.post("/v1/grants", { issuer: "app", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60, parentGrantId: w.appGrant }),
        201,
      );
      await must(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, auth(child.body.id)), 201);
      await must(c.post(`/v1/grants/${w.appGrant}/revoke`, { by: "alice", scopes: ["cart:write"] }), 200);
      await expectError(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, auth(child.body.id)), "SCOPE_INSUFFICIENT", 403);
      await expectError(
        c.post("/v1/grants", { issuer: "app", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60, parentGrantId: w.appGrant }),
        "DELEGATION_INVALID",
      );
    },
  },
  {
    id: "OICT-REV-007", category: "REV", rule: "REV-5", title: "withdrawing every scope revokes the grant",
    async run(c) {
      const w = await world(c, { appScopes: ["order:place", "order:read"] });
      await must(c.post(`/v1/grants/${w.appGrant}/revoke`, { by: "alice", scopes: ["order:place", "order:read"] }), 200);
      await expectError(c.get("/v1/orders/ord_none", auth(w.appGrant)), "GRANT_INACTIVE", 401);
    },
  },

  // ─────────────────────────────── IDM ────────────────────────────────
  {
    id: "OICT-IDM-001", category: "IDM", rule: "IDM-1", title: "order without Idempotency-Key is rejected",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await expectError(c.post("/v1/orders", { sessionId: w.sessionId, confirmationToken: t }, auth(w.appGrant)), "IDEMPOTENCY_KEY_REQUIRED", 400);
    },
  },
  {
    id: "OICT-IDM-002", category: "IDM", rule: "IDM-2", title: "safe retry with the same key replays the same order",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      const key = newKey();
      const a = await must(order(w, t, key), 201);
      const b = await must(order(w, t, key), 200);
      check(a.body.id === b.body.id, "replay returned a different order id");
      check(b.headers.get("oict-idempotent-replay") === "true", "replay header missing");
    },
  },
  {
    id: "OICT-IDM-003", category: "IDM", rule: "IDM-3", title: "reusing a key for a different request is rejected",
    async run(c) {
      const w = await world(c);
      const key = newKey();
      await must(order(w, await confirm(w), key), 201);
      await expectError(order(w, await confirm(w), key), "IDEMPOTENCY_KEY_REUSED", 422);
    },
  },
  {
    id: "OICT-IDM-004", category: "IDM", rule: "IDM-4", title: "regenerated key after timeout cannot buy twice",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await must(order(w, t, newKey()), 201);
      await expectError(order(w, t, newKey()), "CONFIRMATION_CONSUMED", 409);
    },
  },
  {
    id: "OICT-IDM-005", category: "IDM", rule: "IDM-2, IDM-4", title: "burst of 8 concurrent submissions yields one order",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      const key = newKey();
      const rs = await Promise.all(Array.from({ length: 8 }, () => order(w, t, key)));
      const ids = new Set(rs.filter((r) => r.status < 300).map((r) => r.body.id));
      check(ids.size === 1, `expected exactly one order id, got ${ids.size}`);
    },
  },

  // ─────────────────────────────── STB ────────────────────────────────
  {
    id: "OICT-STB-001", category: "STB", rule: "STB-1", title: "every selection change bumps stateVersion",
    async run(c) {
      const w = await world(c);
      const r = await must(c.post(`/v1/sessions/${w.sessionId}/selection`, { sceneObjectId: "obj-hoodie-rack", sku: "SYN-HOODIE-01", variantId: "teal-m", quantity: 1 }), 200);
      check(r.body.stateVersion === w.stateVersion + 1, "stateVersion did not increase");
      check(r.body.snapshotHash !== w.snapshotHash, "snapshot hash did not change");
    },
  },
  {
    id: "OICT-STB-002", category: "STB", rule: "STB-3", title: "confirming an outdated view is refused",
    async run(c) {
      const w = await world(c);
      await must(c.post(`/v1/sessions/${w.sessionId}/selection`, { sceneObjectId: "obj-hoodie-rack", sku: "SYN-HOODIE-01", variantId: "teal-m", quantity: 1 }), 200);
      await expectError(c.post("/v1/confirmations", { sessionId: w.sessionId, consumerId: "alice", snapshotHash: w.snapshotHash }), "STALE_CONFIRMATION", 409);
    },
  },
  {
    id: "OICT-STB-003", category: "STB", rule: "STB-7", title: "price change after confirmation blocks the order",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await must(c.post("/v1/_test/price", { sku: "SYN-HOODIE-01", variantId: "violet-m", unitPriceMinor: 4999 }), 200);
      await expectError(order(w, t), "STALE_CONFIRMATION", 409);
    },
  },
  {
    id: "OICT-STB-004", category: "STB", rule: "STB-7", title: "variant switch after confirmation blocks the order",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await must(c.post(`/v1/sessions/${w.sessionId}/selection`, { sceneObjectId: "obj-hoodie-rack", sku: "SYN-HOODIE-01", variantId: "violet-l", quantity: 1 }), 200);
      await expectError(order(w, t), "STALE_CONFIRMATION", 409);
    },
  },
  {
    id: "OICT-STB-005", category: "STB", rule: "STB-6", title: "expired confirmation is rejected",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      await must(c.post("/v1/_test/clock", { advanceSeconds: 600 }), 200);
      // The root grant lives for an hour, so only the confirmation has expired.
      await expectError(order(w, t), "CONFIRMATION_EXPIRED", 409);
    },
  },
  {
    id: "OICT-STB-006", category: "STB", rule: "STB-5", title: "tampered confirmation token is rejected",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      const [h, body, mac] = t.split(".");
      const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
      claims.totalMinor = 1;
      const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${mac}`;
      await expectError(order(w, forged), "CONFIRMATION_INVALID", 401);
    },
  },
  {
    id: "OICT-STB-007", category: "STB", rule: "STB-5", title: "confirmation from another session is rejected",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      const s2 = await must(c.post("/v1/sessions", { consumerId: "alice", applicationId: "app" }), 201);
      await must(c.post(`/v1/sessions/${s2.body.id}/selection`, { sceneObjectId: "x", sku: "SYN-LAMP-03", variantId: "std", quantity: 1 }), 200);
      await expectError(
        c.post("/v1/orders", { sessionId: s2.body.id, confirmationToken: t }, { ...auth(w.appGrant), ...idem(newKey()) }),
        "CONFIRMATION_INVALID",
      );
    },
  },
  {
    id: "OICT-STB-008", category: "STB", rule: "STB-2, STB-8", title: "placed order carries exactly the confirmed snapshot",
    async run(c) {
      const w = await world(c);
      const r = await must(order(w, await confirm(w)), 201);
      check(r.body.snapshotHash === w.snapshotHash, "order snapshot differs from confirmed snapshot");
      check(r.body.snapshot.lines?.[0]?.variantId === "violet-m" && r.body.totalMinor === 4200, "order contents differ from what was confirmed");
    },
  },
  {
    id: "OICT-STB-009", category: "STB", rule: "STB-5, STB-9", title: "anyone can verify a confirmation with the published keys",
    async run(c) {
      const w = await world(c);
      const t = await confirm(w);
      const jwks = await must(c.get("/.well-known/jwks.json"), 200);
      const [h, p, s] = t.split(".");
      const header = b64json(h!);
      check(header.alg === "EdDSA" && typeof header.kid === "string", "confirmation must be a JWS signed with EdDSA and name its kid");
      const jwk = (jwks.body.keys as any[]).find((k) => k.kid === header.kid);
      check(jwk, "the confirmation's kid is not in /.well-known/jwks.json");
      const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
      check(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s!, "base64url")), "signature does not verify against the published key");
      const claims = b64json(p!);
      check(claims.snapshotHash === w.snapshotHash && claims.sessionId === w.sessionId, "claims do not bind the confirmed snapshot");
    },
  },
  {
    id: "OICT-STB-010", category: "STB", rule: "STB-5", title: "an access token cannot be used as a confirmation",
    async run(c) {
      const w = await world(c);
      await expectError(order(w, tokenFor(w.appGrant)!), "CONFIRMATION_INVALID", 401);
    },
  },
  {
    id: "OICT-STB-011", category: "STB", rule: "STB-2, STB-10", title: "a multi-item confirmation and order cover every line",
    async run(c) {
      const w = await world(c);
      const cart = await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 2 }]);
      check(cart.body.snapshot.lines.length === 2 && cart.body.snapshot.totalMinor === 4200 + 2 * 2900, "snapshot must list every line and total them");
      const r = await must(order(w, await confirm(w)), 201);
      check(r.body.totalMinor === 10000 && r.body.snapshot.lines.length === 2, "order must carry every confirmed line and the confirmed total");
      check(r.body.snapshotHash === w.snapshotHash, "order must be bound to the confirmed cart");
    },
  },
  {
    id: "OICT-STB-012", category: "STB", rule: "STB-1, STB-7", title: "changing a quantity after confirmation blocks the order",
    async run(c) {
      const w = await world(c);
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 2 }]);
      const t = await confirm(w);
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 3 }]);
      await expectError(order(w, t), "STALE_CONFIRMATION", 409);
    },
  },
  {
    id: "OICT-STB-013", category: "STB", rule: "STB-7", title: "a price change on any line blocks the order",
    async run(c) {
      const w = await world(c);
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 1 }]);
      const t = await confirm(w);
      await must(c.post("/v1/_test/price", { ...LAMP, unitPriceMinor: 3100 }), 200);
      await expectError(order(w, t), "STALE_CONFIRMATION", 409);
    },
  },
  {
    id: "OICT-STB-014", category: "STB", rule: "STB-1, STB-7", title: "removing a line after confirmation blocks the order",
    async run(c) {
      const w = await world(c);
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 1 }]);
      const t = await confirm(w);
      await setCart(w, [{ ...HOODIE, quantity: 1 }]);
      await expectError(order(w, t), "STALE_CONFIRMATION", 409);
    },
  },
  {
    id: "OICT-STB-015", category: "STB", rule: "STB-10", title: "a cart cannot mix currencies",
    async run(c) {
      const w = await world(c);
      const r = await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...POSTER_EUR, quantity: 1 }], 400);
      check(r.body?.error?.code === "BAD_REQUEST", "mixed-currency cart must be refused with BAD_REQUEST");
    },
  },
  {
    id: "OICT-STB-016", category: "STB", rule: "STB-10", title: "malformed carts are refused: duplicates, empty, too many lines, bad quantity",
    async run(c) {
      const w = await world(c);
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...HOODIE, quantity: 2 }], 400);
      await setCart(w, [], 400);
      await setCart(w, [{ ...LAMP, quantity: 0 }], 400);
      await setCart(w, [{ ...LAMP, quantity: 100 }], 400);
      const many = Array.from({ length: 21 }, (_, i) => ({ sku: "SYN-LAMP-03", variantId: "std", quantity: 1, sceneObjectId: `o${i}` }));
      await setCart(w, many, 400);
      const before = w.snapshotHash;
      const view = await must(c.get(`/v1/sessions/${w.sessionId}`), 200);
      check(view.body.snapshotHash === before, "a refused cart must not change the session");
    },
  },

  // ─────────────────────────────── AGT ────────────────────────────────
  {
    id: "OICT-AGT-001", category: "AGT", rule: "AGT-1", title: "an agent can never be granted order:place",
    async run(c) {
      await world(c);
      await expectError(c.post("/v1/grants", { issuer: "alice", subject: "helper", application: "app", scopes: ["cart:write", "order:place"], ttlSeconds: 60 }), "AGENT_FORBIDDEN", 403);
    },
  },
  {
    id: "OICT-AGT-002", category: "AGT", rule: "AGT-2", title: "an agent may prepare a draft cart",
    async run(c) {
      const w = await world(c);
      const g = await must(c.post("/v1/grants", { issuer: "alice", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60 }), 201);
      const cart = await must(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, auth(g.body.id)), 201);
      check(cart.body.status === "draft" && cart.body.snapshotHash === w.snapshotHash, "draft cart not bound to current snapshot");
    },
  },
  {
    id: "OICT-AGT-003", category: "AGT", rule: "AGT-3", title: "agent cart built on stale state is refused",
    async run(c) {
      const w = await world(c);
      const g = await must(c.post("/v1/grants", { issuer: "alice", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60 }), 201);
      await must(c.post(`/v1/sessions/${w.sessionId}/selection`, { sceneObjectId: "obj-shoe-wall", sku: "SYN-SNEAKER-07", variantId: "white-9", quantity: 1 }), 200);
      await expectError(c.post("/v1/carts", { sessionId: w.sessionId, stateVersion: w.stateVersion }, auth(g.body.id)), "STALE_STATE", 409);
    },
  },
  {
    id: "OICT-AGT-004", category: "AGT", rule: "AGT-1", title: "an agent holding a valid confirmation still cannot order",
    async run(c) {
      const w = await world(c);
      const g = await must(c.post("/v1/grants", { issuer: "alice", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60 }), 201);
      await expectError(order(w, await confirm(w), newKey(), g.body.id), "SCOPE_INSUFFICIENT", 403);
    },
  },
  {
    id: "OICT-AGT-005", category: "AGT", rule: "AGT-5", title: "an agent acting for a teen needs guardian consent",
    async run(c) {
      await world(c, { ageBand: "13-17" });
      await expectError(c.post("/v1/grants", { issuer: "alice", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60 }), "GUARDIAN_CONSENT_REQUIRED", 403);
      await must(c.post("/v1/grants", { issuer: "alice", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60, guardianConsentRef: "gc_demo_1" }), 201);
    },
  },

  // ─────────────────────────────── MIN ────────────────────────────────
  {
    id: "OICT-MIN-001", category: "MIN", rule: "MIN-1", title: "under-13 consumers cannot authorize purchases",
    async run(c) {
      await must(c.post("/v1/_test/reset"), 200);
      await must(c.post("/v1/participants", { id: "plat", kind: "platform" }), 201);
      await must(c.post("/v1/participants", { id: "dev", kind: "developer" }), 201);
      await must(c.post("/v1/participants", { id: "app", kind: "application", platformId: "plat", developerId: "dev" }), 201);
      await must(c.post("/v1/participants", { id: "kid", kind: "consumer", ageBand: "under13" }), 201);
      await expectError(c.post("/v1/grants", { issuer: "kid", subject: "app", application: "app", scopes: ALL, ttlSeconds: 60 }), "MINOR_RESTRICTED", 403);
    },
  },
  {
    id: "OICT-MIN-002", category: "MIN", rule: "MIN-2", title: "teen order above the limit needs guardian consent",
    async run(c) {
      const w = await world(c, { ageBand: "13-17", sku: "SYN-SNEAKER-07", variantId: "white-9" });
      await expectError(
        c.post("/v1/confirmations", { sessionId: w.sessionId, consumerId: "alice", snapshotHash: w.snapshotHash }),
        "GUARDIAN_CONSENT_REQUIRED",
        403,
      );
    },
  },
  {
    id: "OICT-MIN-003", category: "MIN", rule: "MIN-2", title: "teen order above the limit succeeds with consent",
    async run(c) {
      const w = await world(c, { ageBand: "13-17", sku: "SYN-SNEAKER-07", variantId: "white-9" });
      await must(order(w, await confirm(w, { guardianConsentRef: "gc_demo_2" })), 201);
    },
  },
  {
    id: "OICT-MIN-004", category: "MIN", rule: "MIN-3", title: "teen order within the limit succeeds",
    async run(c) {
      const w = await world(c, { ageBand: "13-17", sku: "SYN-LAMP-03", variantId: "std" });
      await must(order(w, await confirm(w)), 201);
    },
  },
  {
    id: "OICT-MIN-005", category: "MIN", rule: "MIN-2, STB-10", title: "the teen limit applies to the cart total, not each line",
    async run(c) {
      const w = await world(c, { ageBand: "13-17" });
      await setCart(w, [{ ...HOODIE, quantity: 1 }, { ...LAMP, quantity: 1 }]); // 42 + 29: each under 50, total above
      await expectError(
        c.post("/v1/confirmations", { sessionId: w.sessionId, consumerId: "alice", snapshotHash: w.snapshotHash }),
        "GUARDIAN_CONSENT_REQUIRED",
        403,
      );
    },
  },

  // ─────────────────────────────── ERR ────────────────────────────────
  {
    id: "OICT-ERR-001", category: "ERR", rule: "ERR-1", title: "errors use the {error:{code,message}} envelope",
    async run(c) {
      const r = await c.get("/v1/does-not-exist");
      check(r.status === 404, "unknown route should be 404");
      check(typeof r.body?.error?.code === "string" && typeof r.body?.error?.message === "string", "error envelope missing");
      check((r.headers.get("content-type") ?? "").startsWith("application/json"), "content-type must be JSON");
    },
  },
  {
    id: "OICT-ERR-002", category: "ERR", rule: "ERR-2", title: "malformed JSON is a 400, never a 500",
    async run(c) {
      await expectError(c.req("POST", "/v1/participants", "{not json"), "BAD_REQUEST", 400);
    },
  },
];
