import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OictEngine } from "../src/core/engine.ts";
import { canonicalJson, digest } from "../src/core/crypto.ts";
import { SYNTHETIC_CATALOG } from "../src/core/fixtures.ts";
import { bindAgentResponse, isAgentResponseCurrent } from "../src/core/agent-binding.ts";
import { OictError, type AgeBand, type Scope } from "../src/core/types.ts";

const ALL: Scope[] = ["catalog:read", "cart:write", "checkout:prepare", "order:place", "order:read"];

function setup(ageBand: AgeBand = "adult") {
  let t = 1_700_000_000_000;
  const clock = { advance: (s: number) => (t += s * 1000) };
  const e = new OictEngine({ catalog: SYNTHETIC_CATALOG, now: () => t });
  e.registerParticipant({ id: "plat", kind: "platform" });
  e.registerParticipant({ id: "dev", kind: "developer" });
  e.registerParticipant({ id: "app", kind: "application", platformId: "plat", developerId: "dev" });
  e.registerParticipant({ id: "alice", kind: "consumer", ageBand });
  e.registerParticipant({ id: "helper", kind: "agent" });
  const grant = e.issueGrant({ issuer: "alice", subject: "app", application: "app", scopes: ALL, ttlSeconds: 3600 });
  const session = e.createSession("alice", "app");
  const sel = e.updateSelection(session.id, { sceneObjectId: "rack", sku: "SYN-HOODIE-01", variantId: "violet-m", quantity: 1 });
  return { e, grant, session, sel, clock };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof OictError) return err.code;
    throw err;
  }
  return "OK";
};

describe("canonical JSON", () => {
  it("is independent of key order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    assert.equal(digest({ x: 1, y: 2 }), digest({ y: 2, x: 1 }));
  });
  it("drops undefined members", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });
});

describe("happy path", () => {
  it("confirms and places an order bound to the snapshot", () => {
    const { e, grant, session, sel } = setup();
    const { token } = e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    const { order, replayed } = e.placeOrder({ grantId: grant.id, idempotencyKey: "abcdefgh-1", sessionId: session.id, confirmationToken: token });
    assert.equal(replayed, false);
    assert.equal(order.snapshotHash, sel.snapshotHash);
    assert.equal(order.totalMinor, 4200);
  });
});

describe("idempotency", () => {
  it("replays the same result for the same key", () => {
    const { e, grant, session, sel } = setup();
    const { token } = e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    const input = { grantId: grant.id, idempotencyKey: "same-key-1", sessionId: session.id, confirmationToken: token };
    const a = e.placeOrder(input);
    const b = e.placeOrder(input);
    assert.equal(a.order.id, b.order.id);
    assert.equal(b.replayed, true);
    assert.equal(e.orders.size, 1);
  });
  it("blocks a second purchase with a regenerated key", () => {
    const { e, grant, session, sel } = setup();
    const { token } = e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    e.placeOrder({ grantId: grant.id, idempotencyKey: "first-key-1", sessionId: session.id, confirmationToken: token });
    assert.equal(
      code(() => e.placeOrder({ grantId: grant.id, idempotencyKey: "second-key", sessionId: session.id, confirmationToken: token })),
      "CONFIRMATION_CONSUMED",
    );
  });
});

describe("state binding", () => {
  it("rejects confirmation of a stale view", () => {
    const { e, session, sel } = setup();
    e.updateSelection(session.id, { sceneObjectId: "rack", sku: "SYN-HOODIE-01", variantId: "teal-m", quantity: 1 });
    assert.equal(code(() => e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash })), "STALE_CONFIRMATION");
  });
  it("rejects an order after a price change", () => {
    const { e, grant, session, sel } = setup();
    const { token } = e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    e.setPrice("SYN-HOODIE-01", "violet-m", 5100);
    assert.equal(
      code(() => e.placeOrder({ grantId: grant.id, idempotencyKey: "price-key-1", sessionId: session.id, confirmationToken: token })),
      "STALE_CONFIRMATION",
    );
  });
  it("expires confirmations", () => {
    const { e, grant, session, sel, clock } = setup();
    const { token } = e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash });
    clock.advance(121);
    assert.equal(
      code(() => e.placeOrder({ grantId: grant.id, idempotencyKey: "late-key-01", sessionId: session.id, confirmationToken: token })),
      "CONFIRMATION_EXPIRED",
    );
  });
});

describe("delegation & revocation", () => {
  it("cascades revocation", () => {
    const { e, grant, session } = setup();
    const child = e.issueGrant({ issuer: "app", subject: "helper", application: "app", scopes: ["cart:write"], ttlSeconds: 60, parentGrantId: grant.id });
    assert.equal(e.isGrantActive(child), true);
    e.revokeGrant(grant.id, "alice");
    assert.equal(e.isGrantActive(child), false);
    assert.equal(code(() => e.prepareCart(child.id, session.id, session.stateVersion)), "GRANT_INACTIVE");
  });
  it("refuses scope escalation", () => {
    const { e } = setup();
    const narrow = e.issueGrant({ issuer: "alice", subject: "app", application: "app", scopes: ["cart:write"], ttlSeconds: 60 });
    assert.equal(
      code(() => e.issueGrant({ issuer: "app", subject: "app", application: "app", scopes: ["order:place"], ttlSeconds: 30, parentGrantId: narrow.id })),
      "DELEGATION_INVALID",
    );
  });
});

describe("agents and minors", () => {
  it("never lets an agent hold order:place", () => {
    const { e } = setup();
    assert.equal(code(() => e.issueGrant({ issuer: "alice", subject: "helper", application: "app", scopes: ["order:place"], ttlSeconds: 60 })), "AGENT_FORBIDDEN");
  });
  it("blocks under-13 purchase authority", () => {
    const e = new OictEngine({ catalog: SYNTHETIC_CATALOG });
    e.registerParticipant({ id: "plat", kind: "platform" });
    e.registerParticipant({ id: "dev", kind: "developer" });
    e.registerParticipant({ id: "app", kind: "application", platformId: "plat", developerId: "dev" });
    e.registerParticipant({ id: "kid", kind: "consumer", ageBand: "under13" });
    assert.equal(code(() => e.issueGrant({ issuer: "kid", subject: "app", application: "app", scopes: ALL, ttlSeconds: 60 })), "MINOR_RESTRICTED");
  });
  it("requires guardian consent above the teen limit", () => {
    const { e, session } = setup("13-17");
    const sel = e.updateSelection(session.id, { sceneObjectId: "wall", sku: "SYN-SNEAKER-07", variantId: "white-9", quantity: 1 });
    assert.equal(code(() => e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash })), "GUARDIAN_CONSENT_REQUIRED");
    assert.equal(code(() => e.confirm({ sessionId: session.id, consumerId: "alice", snapshotHash: sel.snapshotHash, guardianConsentRef: "gc_1" })), "OK");
  });
});

describe("agent response binding", () => {
  it("drops a late answer about a previous product", () => {
    const askedAboutA = bindAgentResponse("r1", { sceneObjectId: "A", variantId: "a1", selectionVersion: 3 }, "A is cotton");
    const nowLookingAtB = { sceneObjectId: "B", variantId: "b1", selectionVersion: 4 };
    assert.equal(isAgentResponseCurrent(askedAboutA, nowLookingAtB), false);
    assert.equal(isAgentResponseCurrent(askedAboutA, { sceneObjectId: "A", variantId: "a1", selectionVersion: 3 }), true);
  });
});
