/**
 * Store contract: every Store implementation must enforce the commit-time
 * guarantees on its own, without relying on the engine's earlier checks.
 * These run against MemoryStore always, and against PostgresStore when
 * OICT_TEST_DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SYNTHETIC_CATALOG } from "../src/core/fixtures.ts";
import type { AuditEvent, Grant, Order, Session } from "../src/core/types.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { CommitOrderInput, Store } from "../src/store/store.ts";
import { createTempDatabase, type TempDatabase } from "./support/cluster.ts";

const ADMIN_URL = process.env.OICT_TEST_DATABASE_URL;

interface Target {
  name: string;
  make: () => Promise<Store>;
  cleanup?: () => Promise<void>;
}

const targets: Target[] = [{ name: "MemoryStore", make: async () => new MemoryStore(SYNTHETIC_CATALOG) }];
let db: TempDatabase | undefined;
if (ADMIN_URL) {
  targets.push({
    name: "PostgresStore",
    make: async () => {
      db ??= await createTempDatabase(ADMIN_URL);
      const { PostgresStore } = await import("../src/store/postgres/store.ts");
      const s = await PostgresStore.connect(db.url, SYNTHETIC_CATALOG, { poolSize: 4 });
      await s.reset(SYNTHETIC_CATALOG);
      return s;
    },
    cleanup: async () => db?.drop(),
  });
}

let seq = 0;
const id = (p: string) => `${p}_${++seq}_${Math.random().toString(36).slice(2, 8)}`;

async function seed(store: Store) {
  await store.insertParticipant({ id: "plat", kind: "platform" });
  await store.insertParticipant({ id: "dev", kind: "developer" });
  await store.insertParticipant({ id: "app", kind: "application", platformId: "plat", developerId: "dev" });
  await store.insertParticipant({ id: "alice", kind: "consumer", ageBand: "adult" });
  const grant: Grant = {
    id: id("grt"), issuer: "alice", subject: "app", application: "app",
    scopes: ["cart:write", "order:place", "order:read"], issuedAt: 1, expiresAt: 9e12,
  };
  await store.insertGrant(grant);
  const session: Session = { id: id("ses"), consumerId: "alice", applicationId: "app", stateVersion: 0, createdAt: 1 };
  await store.insertSession(session);
  const s = (await store.updateCart(session.id, [
    { sceneObjectId: "a", sku: "SYN-HOODIE-01", variantId: "violet-m", quantity: 1 },
    { sceneObjectId: "b", sku: "SYN-LAMP-03", variantId: "std", quantity: 2 },
  ]))!;
  return { grant, session: s };
}

/** A commit request whose expectations match the store's current versions for the given cart lines. */
async function input(
  store: Store,
  grant: Grant,
  session: Session,
  over: Partial<CommitOrderInput> = {},
  cart: [string, string][] = [["SYN-HOODIE-01", "violet-m"], ["SYN-LAMP-03", "std"]],
): Promise<CommitOrderInput> {
  const lines = await Promise.all(
    cart.map(async ([sku, variantId]) => {
      const v = (await store.getVariant(sku, variantId))!.variant;
      return { sku, variantId, variantVersion: v.variantVersion, priceVersion: v.priceVersion };
    }),
  );
  const orderId = id("ord");
  const order: Order = {
    id: orderId, sessionId: session.id, consumerId: "alice", applicationId: "app", placedBy: "app", grantId: grant.id,
    snapshot: { sessionId: session.id, stateVersion: session.stateVersion, currency: "USD", totalMinor: 10000, lines: [] },
    snapshotHash: "sha256:test", totalMinor: 10000, currency: "USD", createdAt: 2,
  };
  const audit: AuditEvent = { id: id("evt"), at: 2, type: "order.placed", actor: "app", consumerId: "alice", applicationId: "app", orderId };
  return {
    order, audit, nonce: id("nonce"), grantId: grant.id, idempotencyKey: id("key"), fingerprint: "fp-1",
    expect: { sessionId: session.id, stateVersion: session.stateVersion, lines },
    ...over,
  };
}

for (const t of targets) {
  describe(`store contract: ${t.name}`, () => {
    let store: Store;
    before(async () => {
      store = await t.make();
    });
    after(async () => {
      await store?.close();
      await t.cleanup?.();
    });

    it("commits when every version still matches", async () => {
      const { grant, session } = await seed(store);
      assert.equal((await store.commitOrder(await input(store, grant, session))).kind, "created");
    });

    it("refuses when any one line's price changed after the pre-check (STB-7)", async () => {
      const { grant, session } = await seed(store);
      const pending = await input(store, grant, session);
      await store.setPrice("SYN-LAMP-03", "std", 3300);
      assert.equal((await store.commitOrder(pending)).kind, "stale");
      await store.setPrice("SYN-LAMP-03", "std", 2900);
    });

    it("refuses when the cart changed after the pre-check", async () => {
      const { grant, session } = await seed(store);
      const pending = await input(store, grant, session);
      await store.updateCart(session.id, [{ sceneObjectId: "a", sku: "SYN-HOODIE-01", variantId: "violet-m", quantity: 3 }]);
      assert.equal((await store.commitOrder(pending)).kind, "stale");
    });

    it("lets a confirmation nonce buy once, whatever the key (IDM-4)", async () => {
      const { grant, session } = await seed(store);
      const first = await input(store, grant, session);
      assert.equal((await store.commitOrder(first)).kind, "created");
      assert.equal((await store.commitOrder(await input(store, grant, session, { nonce: first.nonce }))).kind, "nonce_consumed");
    });

    it("replays the same key and refuses the same key for a different request (IDM-2, IDM-3)", async () => {
      const { grant, session } = await seed(store);
      const first = await input(store, grant, session);
      const created = await store.commitOrder(first);
      const replay = await store.commitOrder(await input(store, grant, session, { idempotencyKey: first.idempotencyKey }));
      assert.equal(replay.kind, "replay");
      assert.equal(replay.kind === "replay" && created.kind === "created" && replay.order.id, created.kind === "created" && created.order.id);
      const reused = await store.commitOrder(await input(store, grant, session, { idempotencyKey: first.idempotencyKey, fingerprint: "fp-other" }));
      assert.equal(reused.kind, "key_reused");
    });

    it("writes the order's audit event with the order, and only then", async () => {
      const { grant, session } = await seed(store);
      const stale = await input(store, grant, session);
      await store.updateCart(session.id, [{ sceneObjectId: "a", sku: "SYN-LAMP-03", variantId: "std", quantity: 1 }]);
      await store.commitOrder(stale);
      const ok = await input(store, grant, { ...session, stateVersion: session.stateVersion + 1 }, {}, [["SYN-LAMP-03", "std"]]);
      await store.commitOrder(ok);
      const trail = await store.listAudit({ consumerId: "alice", applicationId: "app", limit: 200 });
      assert.ok(trail.some((e) => e.orderId === ok.order.id), "committed order has its event");
      assert.ok(!trail.some((e) => e.orderId === stale.order.id), "a refused commit leaves no order event");
    });

    it("increments stateVersion on every cart update, losing none under concurrency (STB-1)", async () => {
      const { session } = await seed(store);
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          store.updateCart(session.id, [{ sceneObjectId: "a", sku: "SYN-LAMP-03", variantId: "std", quantity: (i % 9) + 1 }]),
        ),
      );
      const versions = results.map((r) => r!.stateVersion).sort((a, b) => a - b);
      assert.deepEqual(versions, Array.from({ length: 25 }, (_, i) => session.stateVersion + i + 1));
    });

    it("narrows scopes atomically and keeps the rest (REV-5)", async () => {
      const { grant } = await seed(store);
      const g = (await store.narrowGrant(grant.id, ["order:place", "cart:write"]))!;
      assert.deepEqual(g.scopes, ["order:read"]);
      assert.deepEqual((await store.getGrant(grant.id))!.scopes, ["order:read"]);
    });
  });
}
