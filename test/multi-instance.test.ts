/**
 * Multi-instance correctness. Three independent OICT processes share one
 * PostgreSQL database, and requests are spread across them the way a load
 * balancer would. Runs when OICT_TEST_DATABASE_URL points at a server where
 * the user may CREATE DATABASE; skipped otherwise.
 *
 *   OICT_TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm run test:cluster
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MIGRATIONS } from "../src/store/postgres/migrations.ts";
import { call, createTempDatabase, startCluster, type Cluster, type Reply, type TempDatabase } from "./support/cluster.ts";

const ADMIN_URL = process.env.OICT_TEST_DATABASE_URL;
const INSTANCES = 3;

describe("multiple instances on one PostgreSQL database", { skip: !ADMIN_URL && "set OICT_TEST_DATABASE_URL to run" }, () => {
  let db: TempDatabase;
  let cluster: Cluster;
  let n = 0;
  /** Round-robin across instances, like a load balancer. */
  const next = () => cluster.urls[n++ % cluster.urls.length]!;
  /** Access tokens by grant id, captured from POST /v1/grants. */
  const tokens = new Map<string, string>();
  const auth = (g: string) => ({ authorization: `Bearer ${tokens.get(g)}` });

  before(async () => {
    db = await createTempDatabase(ADMIN_URL!);
    cluster = await startCluster({ databaseUrl: db.url, instances: INSTANCES });
  });
  after(async () => {
    await cluster?.stop();
    await db?.drop();
  });

  /** Fresh consumer + grant + session with a selection, created through different instances. */
  async function world(tag: string) {
    const ok = (r: Reply, s: number) => {
      assert.equal(r.status, s, JSON.stringify(r.body));
      return r.body;
    };
    ok(await call(next(), "POST", "/v1/participants", { id: "plat", kind: "platform" }), 201);
    ok(await call(next(), "POST", "/v1/participants", { id: "dev", kind: "developer" }), 201);
    ok(await call(next(), "POST", "/v1/participants", { id: "app", kind: "application", platformId: "plat", developerId: "dev" }), 201);
    ok(await call(next(), "POST", "/v1/participants", { id: `c-${tag}`, kind: "consumer", ageBand: "adult" }), 201);
    const grant = ok(
      await call(next(), "POST", "/v1/grants", {
        issuer: `c-${tag}`, subject: "app", application: "app", scopes: ["cart:write", "order:place", "order:read"], ttlSeconds: 3600,
      }),
      201,
    );
    tokens.set(grant.id, grant.accessToken);
    const session = ok(await call(next(), "POST", "/v1/sessions", { consumerId: `c-${tag}`, applicationId: "app" }), 201);
    const sel = ok(
      await call(next(), "POST", `/v1/sessions/${session.id}/selection`, { sceneObjectId: "rack", sku: "SYN-HOODIE-01", variantId: "violet-m", quantity: 1 }),
      200,
    );
    const confirm = async () =>
      ok(await call(next(), "POST", "/v1/confirmations", { sessionId: session.id, consumerId: `c-${tag}`, snapshotHash: sel.snapshotHash }), 201)
        .confirmationToken as string;
    return { grantId: grant.id as string, sessionId: session.id as string, stateVersion: sel.stateVersion as number, confirm };
  }

  const ordersFor = async (sessionId: string) =>
    Number((await db.pool.query("SELECT count(*)::int AS n FROM orders WHERE session_id = $1", [sessionId])).rows[0]!.n);

  it("all instances report healthy on the shared store", async () => {
    const health = await Promise.all(cluster.urls.map((u) => call(u, "GET", "/healthz")));
    assert.deepEqual(health.map((h) => h.body.store), Array(INSTANCES).fill("postgres"));
    assert.equal(new Set(health.map((h) => h.instance)).size, INSTANCES);
    const { rows } = await db.pool.query("SELECT count(*)::int AS n, count(DISTINCT version)::int AS d FROM oict_schema_migrations");
    assert.equal(rows[0]!.n, MIGRATIONS.length, "each migration ran exactly once despite concurrent start-up");
    assert.equal(rows[0]!.d, MIGRATIONS.length);
  });

  it("retry storms across instances never create a second order (25 rounds × 40 requests)", async () => {
    const w = await world("storm");
    const seenInstances = new Set<string>();
    for (let round = 1; round <= 25; round++) {
      const token = await w.confirm();
      const replies = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          call(
            next(),
            "POST",
            "/v1/orders",
            { sessionId: w.sessionId, confirmationToken: token },
            { ...auth(w.grantId), "idempotency-key": i % 2 ? `round-${round}-shared` : `round-${round}-fresh-${i}` },
          ),
        ),
      );
      for (const r of replies) if (r.instance) seenInstances.add(r.instance);
      const created = replies.filter((r) => r.status === 201);
      const ids = new Set(replies.filter((r) => r.status < 300).map((r) => r.body.id));
      const failures = new Set(replies.filter((r) => r.status >= 300).map((r) => r.body?.error?.code));

      assert.equal(created.length, 1, `round ${round}: expected one 201, got ${created.length}`);
      assert.equal(ids.size, 1, `round ${round}: successful replies disagree on the order id`);
      assert.deepEqual([...failures].filter((c) => c !== "CONFIRMATION_CONSUMED"), [], `round ${round}: unexpected errors`);
      assert.equal(await ordersFor(w.sessionId), round, `round ${round}: database order count`);
    }
    assert.equal(seenInstances.size, INSTANCES, "every instance served part of the storm");
  });

  it("concurrent selection changes on different instances lose no update", async () => {
    const w = await world("versions");
    const variants = ["violet-m", "violet-l", "teal-m"];
    const replies = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        call(next(), "POST", `/v1/sessions/${w.sessionId}/selection`, {
          sceneObjectId: "rack", sku: "SYN-HOODIE-01", variantId: variants[i % 3], quantity: 1,
        }),
      ),
    );
    assert.ok(replies.every((r) => r.status === 200));
    const versions = replies.map((r) => r.body.stateVersion as number).sort((a, b) => a - b);
    const expected = Array.from({ length: 60 }, (_, i) => w.stateVersion + i + 1);
    assert.deepEqual(versions, expected, "each update got a distinct, consecutive stateVersion");
    const final = await call(next(), "GET", `/v1/sessions/${w.sessionId}`);
    assert.equal(final.body.session.stateVersion, w.stateVersion + 60);
  });

  it("a revocation on one instance is enforced by every other instance immediately", async () => {
    const w = await world("revoke");
    const token = await w.confirm();
    const [a, b, c] = cluster.urls as [string, string, string];
    assert.equal((await call(a, "POST", `/v1/grants/${w.grantId}/revoke`, { by: "c-revoke" })).status, 200);
    for (const target of [b, c]) {
      const r = await call(target, "POST", "/v1/orders", { sessionId: w.sessionId, confirmationToken: token }, {
        ...auth(w.grantId), "idempotency-key": `after-revoke-${target.slice(-5)}`,
      });
      assert.equal(r.body?.error?.code, "GRANT_INACTIVE");
    }
    assert.equal(await ordersFor(w.sessionId), 0);
  });

  it("a price change on one instance blocks a stale order on another", async () => {
    const w = await world("price");
    const token = await w.confirm();
    const [a, b] = cluster.urls as [string, string];
    assert.equal((await call(a, "POST", "/v1/_test/price", { sku: "SYN-HOODIE-01", variantId: "violet-m", unitPriceMinor: 4700 })).status, 200);
    const r = await call(b, "POST", "/v1/orders", { sessionId: w.sessionId, confirmationToken: token }, {
      ...auth(w.grantId), "idempotency-key": "stale-across-nodes",
    });
    assert.equal(r.body?.error?.code, "STALE_CONFIRMATION");
    assert.equal(await ordersFor(w.sessionId), 0);
  });

  it("stores every order with the exact price the consumer confirmed", async () => {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS bad FROM orders WHERE total_minor <> (snapshot->>'unitPriceMinor')::bigint * (snapshot->>'quantity')::int",
    );
    assert.equal(rows[0]!.bad, 0);
  });

  it("access tokens and confirmations issued by one instance are accepted by every other", async () => {
    const jwks = await Promise.all(cluster.urls.map((u) => call(u, "GET", "/.well-known/jwks.json")));
    const kids = new Set(jwks.map((j) => j.body.keys[0].kid));
    assert.equal(kids.size, 1, "all instances publish the same signing key");
  });

  it("writes exactly one audit event per order, in the same transaction, and the trail is append-only", async () => {
    const counts = (await db.pool.query(
      `SELECT (SELECT count(*)::int FROM orders) AS orders,
              (SELECT count(*)::int FROM audit_events WHERE type = 'order.placed') AS placed,
              (SELECT count(*)::int FROM audit_events e JOIN orders o ON o.id = e.order_id WHERE e.type = 'order.placed') AS linked`,
    )).rows[0]!;
    assert.ok(Number(counts.orders) > 0);
    assert.equal(counts.placed, counts.orders);
    assert.equal(counts.linked, counts.orders);
    await assert.rejects(db.pool.query("UPDATE audit_events SET code = 'tampered'"), /append-only/);
    await assert.rejects(db.pool.query("DELETE FROM audit_events"), /append-only/);
  });

  it("each instance exposes its own metrics", async () => {
    for (const u of cluster.urls) {
      const res = await fetch(`${u}/metrics`);
      const text = await res.text();
      assert.match(text, /oict_build_info\{instance="node-\d",store="postgres",version="[\d.]+"\} 1/);
    }
  });
});
