#!/usr/bin/env node
/**
 * Anomaly-injection benchmark.
 *
 * Generates a reproducible stream of purchase flows (seeded PRNG). A share of
 * them carry one injected anomaly — duplicate submission, stale confirmation,
 * revoked authority, agent overreach, missing guardian consent, forged token —
 * and each flow is run against two targets:
 *
 *   • OICT     — the reference engine in this repository
 *   • baseline — a deliberately naive "checkout-only" integration that checks
 *                the bearer grant and nothing else (what a team typically
 *                ships when building from scratch under time pressure)
 *
 * It reports, per anomaly type, how many anomalous flows were blocked and how
 * many legitimate flows were wrongly rejected (false positives).
 *
 *   node benchmarks/anomaly-injection.ts [--flows 5000] [--seed 42] [--out benchmarks/results]
 *
 * All data is synthetic. Results describe this simulator, not any production system.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OictEngine } from "../src/core/engine.ts";
import { SYNTHETIC_CATALOG } from "../src/core/fixtures.ts";
import { OictError, type AgeBand, type Scope } from "../src/core/types.ts";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const FLOWS = Number(opt("flows", "5000"));
const SEED = Number(opt("seed", "42"));
const OUT = opt("out", "benchmarks/results");

// Mulberry32 — tiny, deterministic PRNG.
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

const ANOMALIES = [
  "duplicate_new_key",
  "duplicate_same_key",
  "stale_price",
  "stale_variant",
  "expired_confirmation",
  "revoked_grant",
  "agent_overreach",
  "teen_without_consent",
  "forged_confirmation",
] as const;
type Anomaly = (typeof ANOMALIES)[number];

const ALL: Scope[] = ["catalog:read", "cart:write", "checkout:prepare", "order:place", "order:read"];

/** Outcome of a flow: did an unwanted order come into existence? */
interface FlowResult {
  /** Number of orders that exist at the end of the flow. */
  orders: number;
  /** Number of orders the consumer actually intended (0 or 1). */
  intended: number;
}

interface Target {
  run(anomaly: Anomaly | null, rnd: () => number): FlowResult;
}

// ─────────────────────────────── OICT target ───────────────────────────────

function oictTarget(): Target {
  return {
    run(anomaly, rnd) {
      let t = 1_700_000_000_000;
      const e = new OictEngine({ catalog: SYNTHETIC_CATALOG, now: () => t });
      const teen = anomaly === "teen_without_consent";
      const age: AgeBand = teen ? "13-17" : anomaly === "agent_overreach" ? "adult" : rnd() < 0.2 ? "13-17" : "adult";
      e.registerParticipant({ id: "plat", kind: "platform" });
      e.registerParticipant({ id: "dev", kind: "developer" });
      e.registerParticipant({ id: "app", kind: "application", platformId: "plat", developerId: "dev" });
      e.registerParticipant({ id: "c", kind: "consumer", ageBand: age });
      e.registerParticipant({ id: "agent", kind: "agent" });
      const grant = e.issueGrant({ issuer: "c", subject: "app", application: "app", scopes: ALL, ttlSeconds: 3600 });
      const s = e.createSession("c", "app");
      // Legit teen flows pick an item under the limit; the injected teen anomaly picks one above it.
      const pick = teen ? ["SYN-SNEAKER-07", "white-9"] : age === "13-17" ? ["SYN-LAMP-03", "std"] : ["SYN-HOODIE-01", "violet-m"];
      const sel = e.updateSelection(s.id, { sceneObjectId: "o1", sku: pick[0]!, variantId: pick[1]!, quantity: 1 });

      const tryDo = (fn: () => void) => {
        try {
          fn();
        } catch (err) {
          if (!(err instanceof OictError)) throw err;
        }
      };

      let token = "";
      tryDo(() => (token = e.confirm({ sessionId: s.id, consumerId: "c", snapshotHash: sel.snapshotHash }).token));
      if (!token) return { orders: e.orders.size, intended: 0 };

      let grantId = grant.id;
      if (anomaly === "stale_price") e.setPrice(pick[0]!, pick[1]!, 4999);
      if (anomaly === "stale_variant") e.updateSelection(s.id, { sceneObjectId: "o1", sku: "SYN-HOODIE-01", variantId: "teal-m", quantity: 1 });
      if (anomaly === "expired_confirmation") t += 10 * 60 * 1000;
      if (anomaly === "revoked_grant") e.revokeGrant(grant.id, "c");
      if (anomaly === "agent_overreach") {
        // The best an agent can obtain is cart:write; it then tries to order anyway.
        grantId = e.issueGrant({ issuer: "c", subject: "agent", application: "app", scopes: ["cart:write"], ttlSeconds: 60 }).id;
      }
      if (anomaly === "forged_confirmation") {
        const [h, b, m] = token.split(".");
        const claims = JSON.parse(Buffer.from(b!, "base64url").toString());
        claims.totalMinor = 1;
        token = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${m}`;
      }

      const key1 = `k-${Math.floor(rnd() * 1e12)}`;
      tryDo(() => e.placeOrder({ grantId, idempotencyKey: key1, sessionId: s.id, confirmationToken: token }));
      if (anomaly === "duplicate_same_key") {
        tryDo(() => e.placeOrder({ grantId, idempotencyKey: key1, sessionId: s.id, confirmationToken: token }));
      }
      if (anomaly === "duplicate_new_key") {
        tryDo(() => e.placeOrder({ grantId, idempotencyKey: `k-${Math.floor(rnd() * 1e12)}-retry`, sessionId: s.id, confirmationToken: token }));
      }
      return { orders: e.orders.size, intended: intendedOrders(anomaly) };
    },
  };
}

// ────────────────────────────── naive baseline ─────────────────────────────

function baselineTarget(): Target {
  return {
    run(anomaly) {
      // Checks only that the bearer grant exists, is not revoked, and has order:place.
      const grants = new Map<string, { scopes: Scope[]; revoked: boolean }>();
      grants.set("g-app", { scopes: ALL, revoked: false });
      let orders = 0;
      let grantId = "g-app";
      const place = () => {
        const g = grants.get(grantId);
        if (!g || g.revoked || !g.scopes.includes("order:place")) return;
        orders += 1; // trusts the client's cart, price and confirmation blindly
      };
      if (anomaly === "revoked_grant") grants.get("g-app")!.revoked = true;
      if (anomaly === "agent_overreach") {
        // Nothing stops an agent from being handed the app's full scopes.
        grants.set("g-agent", { scopes: ALL, revoked: false });
        grantId = "g-agent";
      }
      place();
      if (anomaly === "duplicate_same_key" || anomaly === "duplicate_new_key") place();
      return { orders, intended: intendedOrders(anomaly) };
    },
  };
}

/** Orders the consumer actually meant to have at the end of the flow. */
function intendedOrders(anomaly: Anomaly | null): number {
  switch (anomaly) {
    case null:
    case "duplicate_new_key":
    case "duplicate_same_key":
      return 1; // they meant to buy once
    default:
      return 0; // stale, unauthorized, forged or non-consented: no order should exist
  }
}

// ──────────────────────────────── runner ──────────────────────────────────

interface Tally {
  injected: number;
  blocked: number;
}

function runAll(target: Target, seed: number) {
  const rnd = prng(seed);
  const per: Record<string, Tally> = Object.fromEntries(ANOMALIES.map((a) => [a, { injected: 0, blocked: 0 }]));
  let normal = 0;
  let falsePositives = 0;
  for (let i = 0; i < FLOWS; i++) {
    const anomaly: Anomaly | null = rnd() < 0.4 ? ANOMALIES[Math.floor(rnd() * ANOMALIES.length)]! : null;
    const r = target.run(anomaly, rnd);
    if (anomaly === null) {
      normal += 1;
      if (r.orders !== 1) falsePositives += 1;
    } else {
      per[anomaly]!.injected += 1;
      if (r.orders === r.intended) per[anomaly]!.blocked += 1;
    }
  }
  const injected = Object.values(per).reduce((s, x) => s + x.injected, 0);
  const blocked = Object.values(per).reduce((s, x) => s + x.blocked, 0);
  return { per, injected, blocked, normal, falsePositives, detectionRate: blocked / injected, falsePositiveRate: falsePositives / Math.max(normal, 1) };
}

const t0 = performance.now();
const oict = runAll(oictTarget(), SEED);
const base = runAll(baselineTarget(), SEED);
const ms = Math.round(performance.now() - t0);

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const p = (c: string) => (s: string) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = p("90"), green = p("32"), red = p("31"), bold = p("1"), magenta = p("35");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`\n  ${magenta("◆")} ${bold("OICT anomaly-injection benchmark")}  ${dim(`flows=${FLOWS} seed=${SEED} ${ms}ms`)}\n`);
console.log(`  ${"anomaly".padEnd(24)}${"injected".padStart(9)}${"OICT".padStart(10)}${"baseline".padStart(11)}`);
console.log(dim(`  ${"─".repeat(54)}`));
for (const a of ANOMALIES) {
  const o = oict.per[a]!, b = base.per[a]!;
  const or = o.blocked / Math.max(o.injected, 1), br = b.blocked / Math.max(b.injected, 1);
  console.log(`  ${a.padEnd(24)}${String(o.injected).padStart(9)}${(or === 1 ? green : red)(pct(or).padStart(10))}${(br === 1 ? green : red)(pct(br).padStart(11))}`);
}
console.log(dim(`  ${"─".repeat(54)}`));
console.log(`  ${bold("detection rate".padEnd(24))}${String(oict.injected).padStart(9)}${green(bold(pct(oict.detectionRate).padStart(10)))}${red(pct(base.detectionRate).padStart(11))}`);
console.log(`  ${"false-positive rate".padEnd(24)}${String(oict.normal).padStart(9)}${pct(oict.falsePositiveRate).padStart(10)}${pct(base.falsePositiveRate).padStart(11)}\n`);

mkdirSync(OUT, { recursive: true });
const result = {
  benchmark: "oict-anomaly-injection",
  version: "0.1.0",
  flows: FLOWS,
  seed: SEED,
  note: "Synthetic simulation. Baseline = checkout-only integration that validates the bearer grant and nothing else.",
  oict,
  baseline: base,
};
writeFileSync(join(OUT, "latest.json"), JSON.stringify(result, null, 2));

const md = [
  `# Anomaly-injection results`,
  ``,
  `Generated by \`npm run bench\` — ${FLOWS} synthetic flows, seed ${SEED}. Re-run to reproduce.`,
  ``,
  `| Anomaly | Injected | OICT blocked | Baseline blocked |`,
  `|---|---:|---:|---:|`,
  ...ANOMALIES.map((a) => {
    const o = oict.per[a]!, b = base.per[a]!;
    return `| \`${a}\` | ${o.injected} | ${pct(o.blocked / Math.max(o.injected, 1))} | ${pct(b.blocked / Math.max(b.injected, 1))} |`;
  }),
  `| **Detection rate** | **${oict.injected}** | **${pct(oict.detectionRate)}** | ${pct(base.detectionRate)} |`,
  `| False-positive rate (legit flows) | ${oict.normal} | ${pct(oict.falsePositiveRate)} | ${pct(base.falsePositiveRate)} |`,
  ``,
  `*Baseline* is a deliberately naive checkout-only integration (bearer grant check only).`,
  `These numbers describe the simulator in this repository, not any production system.`,
  ``,
].join("\n");
writeFileSync(join(OUT, "latest.md"), md);
console.log(dim(`  wrote ${join(OUT, "latest.json")} and latest.md\n`));
