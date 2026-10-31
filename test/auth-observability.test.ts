import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { OictEngine } from "../src/core/engine.ts";
import { SYNTHETIC_CATALOG } from "../src/core/fixtures.ts";
import { KeyRing, loadSigningKey, TOKEN_TYPES } from "../src/core/jose.ts";
import { OictError, type Scope } from "../src/core/types.ts";
import { createServer } from "../src/server/http.ts";
import { MemoryStore } from "../src/store/memory.ts";

const ALL: Scope[] = ["catalog:read", "cart:write", "checkout:prepare", "order:place", "order:read"];
const SEED_A = "11".repeat(32);
const SEED_B = "22".repeat(32);

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof OictError) return err.code;
    throw err;
  }
  return "OK";
}

async function world(e: OictEngine, consumer = "alice") {
  await e.registerParticipant({ id: "plat", kind: "platform" });
  await e.registerParticipant({ id: "dev", kind: "developer" });
  await e.registerParticipant({ id: "app", kind: "application", platformId: "plat", developerId: "dev" });
  await e.registerParticipant({ id: "app2", kind: "application", platformId: "plat", developerId: "dev" });
  await e.registerParticipant({ id: consumer, kind: "consumer", ageBand: "adult" });
  const grant = await e.issueGrant({ issuer: consumer, subject: "app", application: "app", scopes: ALL, ttlSeconds: 3600 });
  const session = await e.createSession(consumer, "app");
  const sel = await e.updateSelection(session.id, { sceneObjectId: "rack", sku: "SYN-HOODIE-01", variantId: "violet-m", quantity: 1 });
  return { grant, session, sel };
}

describe("access tokens", () => {
  it("authenticates a token it issued and binds the caller to the grant's subject", async () => {
    const e = new OictEngine({ catalog: SYNTHETIC_CATALOG });
    const { grant } = await world(e);
    const { accessToken } = e.issueAccessToken(grant);
    assert.deepEqual(e.authenticate(`Bearer ${accessToken}`), { grantId: grant.id, subject: "app", scopes: ALL });
  });

  it("refuses a caller whose authenticated subject is not the grant's subject", async () => {
    const e = new OictEngine({ catalog: SYNTHETIC_CATALOG });
    const { grant, session, sel } = await world(e);
    const { token } = await e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    assert.equal(
      await code(() => e.placeOrder({ grantId: grant.id, subject: "app2", idempotencyKey: "mismatch-1", sessionId: session.id, confirmationToken: token })),
      "UNAUTHENTICATED",
    );
  });

  it("lets token scopes narrow, but never widen, the grant", async () => {
    const e = new OictEngine({ catalog: SYNTHETIC_CATALOG });
    const { grant, session, sel } = await world(e);
    const { token } = await e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    assert.equal(
      await code(() => e.placeOrder({ grantId: grant.id, subject: "app", scopes: ["order:read"], idempotencyKey: "narrow-1", sessionId: session.id, confirmationToken: token })),
      "SCOPE_INSUFFICIENT",
    );
  });

  it("rejects tokens from an untrusted issuer or for another audience, even with a shared key", async () => {
    const keys = new KeyRing(loadSigningKey(SEED_A));
    const a = new OictEngine({ catalog: SYNTHETIC_CATALOG, keys, issuer: "urn:a" });
    const b = new OictEngine({ catalog: SYNTHETIC_CATALOG, keys, issuer: "urn:b" });
    const c = new OictEngine({ catalog: SYNTHETIC_CATALOG, keys, issuer: "urn:a", audience: "other-service" });
    const { grant } = await world(a);
    const { accessToken } = a.issueAccessToken(grant);
    assert.equal(await code(() => b.authenticate(`Bearer ${accessToken}`)), "UNAUTHENTICATED");
    assert.equal(await code(() => c.authenticate(`Bearer ${accessToken}`)), "UNAUTHENTICATED");
  });

  it("rejects an expired token", async () => {
    let t = 1_700_000_000_000;
    const e = new OictEngine({ catalog: SYNTHETIC_CATALOG, now: () => t, accessTokenTtlSeconds: 60 });
    const { grant } = await world(e);
    const { accessToken } = e.issueAccessToken(grant);
    t += 61_000;
    assert.equal(await code(() => e.authenticate(`Bearer ${accessToken}`)), "UNAUTHENTICATED");
  });

  it("refuses the legacy grant-id header unless explicitly allowed", async () => {
    const strict = new OictEngine({ catalog: SYNTHETIC_CATALOG });
    const lax = new OictEngine({ catalog: SYNTHETIC_CATALOG, allowGrantHeader: true });
    assert.equal(await code(() => strict.authenticate("OICT-Grant grt_x")), "UNAUTHENTICATED");
    assert.deepEqual(lax.authenticate("OICT-Grant grt_x"), { grantId: "grt_x" });
    assert.equal(await code(() => strict.authenticate(undefined)), "UNKNOWN_GRANT");
  });

  it("survives key rotation: tokens signed with the previous key still verify", async () => {
    const store = new MemoryStore(SYNTHETIC_CATALOG);
    const oldKeys = new KeyRing(loadSigningKey(SEED_A));
    const before = new OictEngine({ store, keys: oldKeys });
    const after = new OictEngine({ store, keys: new KeyRing(loadSigningKey(SEED_B), oldKeys.jwks()) });
    const { grant, session, sel } = await world(before);
    const { token } = await before.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    const caller = after.authenticate(`Bearer ${before.issueAccessToken(grant).accessToken}`);
    const { order } = await after.placeOrder({ ...caller, idempotencyKey: "rotation-1", sessionId: session.id, confirmationToken: token });
    assert.equal(order.totalMinor, 4200);
    assert.equal(after.keys.jwks().keys.length, 2);
  });

  it("keeps token types apart", () => {
    const keys = KeyRing.ephemeral();
    const confirmation = keys.sign(TOKEN_TYPES.confirmation, { v: 1 });
    assert.equal(keys.verify(TOKEN_TYPES.access, confirmation), null);
    assert.deepEqual(keys.verify(TOKEN_TYPES.confirmation, confirmation), { v: 1 });
  });
});

describe("audit trail", () => {
  it("records grants, the order and refusals, scoped to the consumer and application", async () => {
    const e = new OictEngine({ catalog: SYNTHETIC_CATALOG });
    const { grant, session, sel } = await world(e);
    const { token } = await e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    await e.placeOrder({ grantId: grant.id, idempotencyKey: "audit-order-1", sessionId: session.id, confirmationToken: token });
    await code(() => e.placeOrder({ grantId: grant.id, idempotencyKey: "audit-order-2", sessionId: session.id, confirmationToken: token }));

    const events = await e.listAudit(grant.id);
    assert.deepEqual(events.map((x) => x.type).reverse(), ["grant.issued", "order.placed", "order.refused"]);
    assert.equal(events[0]!.code, "CONFIRMATION_CONSUMED");
    assert.equal(events[1]!.actor, "app");
    assert.equal(events[1]!.consumerId, "alice");

    await e.registerParticipant({ id: "bob", kind: "consumer", ageBand: "adult" });
    const bobGrant = await e.issueGrant({ issuer: "bob", subject: "app", application: "app", scopes: ["order:read"], ttlSeconds: 60 });
    const bobView = await e.listAudit(bobGrant.id);
    assert.ok(bobView.every((x) => x.consumerId === "bob"), "one consumer never sees another's trail");
  });
});

describe("HTTP observability", () => {
  const lines: Record<string, unknown>[] = [];
  const server = createServer({ instanceId: "obs-1", log: (l) => lines.push(l) });
  let base = "";
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };

  it("logs one structured line per request, metrics count orders and refusals, audit needs a token", async () => {
    await post("/v1/participants", { id: "plat", kind: "platform" });
    await post("/v1/participants", { id: "dev", kind: "developer" });
    await post("/v1/participants", { id: "app", kind: "application", platformId: "plat", developerId: "dev" });
    await post("/v1/participants", { id: "maya", kind: "consumer", ageBand: "adult" });
    const g = (await post("/v1/grants", { issuer: "maya", subject: "app", application: "app", scopes: ALL, ttlSeconds: 600 })).body;
    const s = (await post("/v1/sessions", { consumerId: "maya", applicationId: "app" })).body;
    const sel = (await post(`/v1/sessions/${s.id}/selection`, { sceneObjectId: "o", sku: "SYN-LAMP-03", variantId: "std" })).body;
    const t = (await post("/v1/confirmations", { sessionId: s.id, consumerId: "maya", snapshotHash: sel.snapshotHash })).body.confirmationToken;
    const auth = { authorization: `Bearer ${g.accessToken}` };

    const ok = await post("/v1/orders", { sessionId: s.id, confirmationToken: t }, { ...auth, "idempotency-key": "obs-key-1", "x-request-id": "trace-abc" });
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get("x-request-id"), "trace-abc");
    await post("/v1/orders", { sessionId: s.id, confirmationToken: t }, { ...auth, "idempotency-key": "obs-key-1" });
    await post("/v1/orders", { sessionId: s.id, confirmationToken: t }, { ...auth, "idempotency-key": "obs-key-2" });

    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /^# TYPE oict_http_requests_total counter$/m);
    assert.match(metrics, /^oict_orders_total\{result="created"\} 1$/m);
    assert.match(metrics, /^oict_orders_total\{result="replayed"\} 1$/m);
    assert.match(metrics, /^oict_integrity_refusals_total\{code="CONFIRMATION_CONSUMED"\} 1$/m);
    assert.match(metrics, /^oict_http_request_duration_seconds_bucket\{route="\/v1\/orders",le="\+Inf"\} 3$/m);
    assert.match(metrics, /^oict_build_info\{instance="obs-1",store="memory",version="0\.3\.0"\} 1$/m);

    const line = lines.find((l) => l.requestId === "trace-abc")!;
    assert.equal(line.route, "/v1/orders");
    assert.equal(line.status, 201);
    assert.equal(line.subject, "app");
    assert.ok(lines.every((l) => !String(l.route).includes("ord_") && !String(l.route).includes("ses_")), "routes are templates, never raw ids");

    const denied = await fetch(`${base}/v1/audit`);
    assert.equal(denied.status, 401);
    const trail = (await (await fetch(`${base}/v1/audit`, { headers: auth })).json()) as { events: any[] };
    const placed = trail.events.find((e) => e.type === "order.placed");
    assert.equal(placed.requestId, "trace-abc", "audit events carry the request id for tracing");
    assert.equal(placed.instance, "obs-1");
  });
});
