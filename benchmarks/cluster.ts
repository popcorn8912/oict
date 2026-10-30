#!/usr/bin/env node
/**
 * Cluster load benchmark.
 *
 * Starts N OICT instances on one fresh PostgreSQL database and lets many
 * simulated shoppers buy at the same time. Every purchase ends in a retry
 * storm (same key and regenerated keys, spread over random instances), and a
 * share of purchases race a merchant price change, forcing a re-confirm.
 *
 * The run passes only if the database ends with exactly one order per
 * intended purchase and every order carries the price that was confirmed.
 *
 *   OICT_TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres \
 *     node benchmarks/cluster.ts [--instances 3] [--shoppers 40] [--purchases 15] [--seed 7]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, createTempDatabase, startCluster } from "../test/support/cluster.ts";

const args = process.argv.slice(2);
const opt = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
const INSTANCES = opt("instances", 3);
const SHOPPERS = opt("shoppers", 40);
const PURCHASES = opt("purchases", 15);
const SEED = opt("seed", 7);
const STORM = 4;
const PRICE_RACE = 0.05;
const MAX_ATTEMPTS = 25;
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1]! : "benchmarks/results";
const ADMIN_URL = process.env.OICT_TEST_DATABASE_URL ?? process.env.OICT_BENCH_DATABASE_URL;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const p = (c: string) => (s: string) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = p("90"), green = p("32"), red = p("31"), bold = p("1"), magenta = p("35"), cyan = p("36");

if (!ADMIN_URL) {
  console.error("Set OICT_TEST_DATABASE_URL to a PostgreSQL server where you may CREATE DATABASE.");
  process.exit(2);
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(SEED);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};

const VARIANTS = [
  ["SYN-HOODIE-01", "violet-m"],
  ["SYN-HOODIE-01", "teal-m"],
  ["SYN-SNEAKER-07", "white-9"],
  ["SYN-LAMP-03", "std"],
] as const;

console.log(`\n  ${magenta("◆")} ${bold("OICT cluster benchmark")}  ${dim(`instances=${INSTANCES} shoppers=${SHOPPERS} purchases=${PURCHASES} seed=${SEED}`)}`);

const db = await createTempDatabase(ADMIN_URL);
const cluster = await startCluster({ databaseUrl: db.url, instances: INSTANCES, poolSize: 12 });
const node = () => pick(cluster.urls);
console.log(`  ${dim("cluster")} ${cyan(cluster.urls.join("  "))}\n`);

const orderLatency: number[] = [];
const purchaseLatency: number[] = [];
const byInstance = new Map<string, number>();
const outcomes = { created: 0, replayed: 0, consumed: 0, staleRetries: 0, otherErrors: 0, requests: 0 };
let failures: string[] = [];

async function req(...a: Parameters<typeof call>) {
  const r = await call(...a);
  outcomes.requests++;
  if (r.instance) byInstance.set(r.instance, (byInstance.get(r.instance) ?? 0) + 1);
  return r;
}

try {
  const base = cluster.urls[0]!;
  await req(base, "POST", "/v1/participants", { id: "plat", kind: "platform" });
  await req(base, "POST", "/v1/participants", { id: "dev", kind: "developer" });
  await req(base, "POST", "/v1/participants", { id: "app", kind: "application", platformId: "plat", developerId: "dev" });

  const shoppers = await Promise.all(
    Array.from({ length: SHOPPERS }, async (_, i) => {
      const id = `shopper-${i}`;
      await req(node(), "POST", "/v1/participants", { id, kind: "consumer", ageBand: "adult" });
      const g = await req(node(), "POST", "/v1/grants", {
        issuer: id, subject: "app", application: "app", scopes: ["order:place", "order:read"], ttlSeconds: 3600,
      });
      const s = await req(node(), "POST", "/v1/sessions", { consumerId: id, applicationId: "app" });
      return { id, grant: g.body.id as string, session: s.body.id as string };
    }),
  );

  const t0 = performance.now();
  await Promise.all(
    shoppers.map(async (sh) => {
      const auth = { authorization: `OICT-Grant ${sh.grant}` };
      for (let k = 0; k < PURCHASES; k++) {
        const start = performance.now();
        const [sku, variantId] = pick(VARIANTS);
        await req(node(), "POST", `/v1/sessions/${sh.session}/selection`, { sceneObjectId: `obj-${k}`, sku, variantId, quantity: 1 + (k % 3) });

        let done = false;
        for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
          // Render what the server says the shopper is looking at, then confirm it.
          const view = await req(node(), "GET", `/v1/sessions/${sh.session}`);
          const conf = await req(node(), "POST", "/v1/confirmations", { sessionId: sh.session, consumerId: sh.id, snapshotHash: view.body.snapshotHash });
          if (conf.status !== 201) {
            outcomes.staleRetries++;
            continue;
          }
          if (attempt === 0 && rnd() < PRICE_RACE) {
            // The merchant reprices this item while the shopper's order is in flight.
            await req(node(), "POST", "/v1/_test/price", { sku, variantId, unitPriceMinor: 2000 + Math.floor(rnd() * 80) * 100 });
          }
          const sharedKey = `${sh.id}-p${k}-a${attempt}`;
          const storm = await Promise.all(
            Array.from({ length: STORM }, (_, i) =>
              req(node(), "POST", "/v1/orders", { sessionId: sh.session, confirmationToken: conf.body.confirmationToken }, {
                ...auth, "idempotency-key": i % 2 === 0 ? sharedKey : `${sharedKey}-regen-${i}`,
              }),
            ),
          );
          for (const r of storm) {
            orderLatency.push(r.ms);
            const code = r.body?.error?.code;
            if (r.status === 201) outcomes.created++;
            else if (r.status === 200) outcomes.replayed++;
            else if (code === "CONFIRMATION_CONSUMED") outcomes.consumed++;
            else if (code === "STALE_CONFIRMATION") void 0;
            else {
              outcomes.otherErrors++;
              failures.push(`${r.status} ${JSON.stringify(r.body)}`);
            }
          }
          if (storm.some((r) => r.status === 201)) done = true;
          else outcomes.staleRetries++;
        }
        if (!done) failures.push(`${sh.id} purchase ${k} never completed`);
        purchaseLatency.push(performance.now() - start);
      }
    }),
  );
  const wall = performance.now() - t0;

  const intended = SHOPPERS * PURCHASES;
  const stored = Number((await db.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0]!.n);
  const dupes = Number(
    (await db.pool.query(
      "SELECT count(*)::int AS n FROM (SELECT session_id, snapshot->>'stateVersion' sv, count(*) c FROM orders GROUP BY 1, 2 HAVING count(*) > 1) d",
    )).rows[0]!.n,
  );
  const priceMismatch = Number(
    (await db.pool.query(
      "SELECT count(*)::int AS n FROM orders WHERE total_minor <> (snapshot->>'unitPriceMinor')::bigint * (snapshot->>'quantity')::int",
    )).rows[0]!.n,
  );
  const pass = stored === intended && dupes === 0 && priceMismatch === 0 && outcomes.otherErrors === 0 && failures.length === 0;

  const row = (label: string, value: string) => console.log(`  ${label.padEnd(34)}${value}`);
  row("intended purchases", String(intended));
  row("orders in database", (stored === intended ? green : red)(bold(String(stored))));
  row("duplicate orders", (dupes === 0 ? green : red)(bold(String(dupes))));
  row("orders priced ≠ confirmation", (priceMismatch === 0 ? green : red)(String(priceMismatch)));
  console.log(dim(`  ${"─".repeat(54)}`));
  row("order requests (retry storms)", String(orderLatency.length));
  row("  → created / replayed", `${outcomes.created} / ${outcomes.replayed}`);
  row("  → blocked as already used", String(outcomes.consumed));
  row("re-confirms after price races", String(outcomes.staleRetries));
  row("unexpected errors", (outcomes.otherErrors ? red : green)(String(outcomes.otherErrors)));
  console.log(dim(`  ${"─".repeat(54)}`));
  row("HTTP requests total", `${outcomes.requests}  ${dim(`(${Math.round(outcomes.requests / (wall / 1000))} req/s)`)}`);
  row("order latency p50 / p95 / p99", `${quantile(orderLatency, 0.5).toFixed(1)} / ${quantile(orderLatency, 0.95).toFixed(1)} / ${quantile(orderLatency, 0.99).toFixed(1)} ms`);
  row("requests per instance", [...byInstance.entries()].sort().map(([k, v]) => `${k}:${v}`).join("  "));
  console.log(`\n  ${pass ? green("✔ exactly one order per intended purchase") : red("✘ invariant violated")}\n`);
  if (failures.length) console.log(red(failures.slice(0, 5).join("\n")));

  const result = {
    benchmark: "oict-cluster",
    version: "0.2.0",
    config: { instances: INSTANCES, shoppers: SHOPPERS, purchasesPerShopper: PURCHASES, stormSize: STORM, priceRaceShare: PRICE_RACE, seed: SEED },
    database: { intended, stored, duplicateOrders: dupes, priceMismatches: priceMismatch },
    outcomes,
    latencyMs: {
      order: { p50: quantile(orderLatency, 0.5), p95: quantile(orderLatency, 0.95), p99: quantile(orderLatency, 0.99) },
      purchase: { p50: quantile(purchaseLatency, 0.5), p95: quantile(purchaseLatency, 0.95) },
    },
    throughputRps: outcomes.requests / (wall / 1000),
    requestsPerInstance: Object.fromEntries([...byInstance.entries()].sort()),
    pass,
    note: "Local run on a single machine with synthetic data; latency depends on hardware and is indicative only.",
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "cluster-latest.json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(OUT, "cluster-latest.md"),
    [
      "# Cluster benchmark",
      "",
      `${INSTANCES} OICT instances · 1 PostgreSQL database · ${SHOPPERS} concurrent shoppers × ${PURCHASES} purchases · every order sent as a ${STORM}-request retry storm across random instances · ${Math.round(PRICE_RACE * 100)}% of purchases race a price change. Seed ${SEED}.`,
      "",
      "| Check | Result |",
      "|---|---:|",
      `| Intended purchases | ${intended} |`,
      `| Orders in database | **${stored}** |`,
      `| Duplicate orders | **${dupes}** |`,
      `| Orders priced differently from the confirmation | ${priceMismatch} |`,
      `| Order requests sent | ${orderLatency.length} |`,
      `| Created / replayed / blocked as already used | ${outcomes.created} / ${outcomes.replayed} / ${outcomes.consumed} |`,
      `| Re-confirms after price races | ${outcomes.staleRetries} |`,
      `| Unexpected errors | ${outcomes.otherErrors} |`,
      `| Order latency p50 / p95 / p99 | ${result.latencyMs.order.p50.toFixed(1)} / ${result.latencyMs.order.p95.toFixed(1)} / ${result.latencyMs.order.p99.toFixed(1)} ms |`,
      `| Throughput | ${Math.round(result.throughputRps)} req/s |`,
      "",
      "Reproduce with `npm run bench:cluster`. Single-machine run with synthetic data: correctness results are the point; latency is indicative only.",
      "",
    ].join("\n"),
  );
  process.exitCode = pass ? 0 : 1;
} finally {
  await cluster.stop();
  await db.drop();
}
