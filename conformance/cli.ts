#!/usr/bin/env node
/**
 * oict-conformance — run the OICT conformance suite against any implementation.
 *
 *   node conformance/cli.ts --target http://localhost:8787   # your service
 *   node conformance/cli.ts --spawn                          # the reference server
 *   node conformance/cli.ts --spawn --filter IDM --json report.json
 *   node conformance/cli.ts --spawn --compact                # one line per category
 *
 * The target must expose the /v1/_test/* fixture hooks (reset, clock, price).
 */
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { CASES, CATEGORY_TITLES, type Category } from "./cases.ts";
import { Client } from "./client.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("90"), green = paint("32"), red = paint("31"), cyan = paint("36"), magenta = paint("35"), bold = paint("1");

interface Outcome {
  id: string;
  category: Category;
  rule: string;
  title: string;
  status: "pass" | "fail";
  ms: number;
  error?: string;
}

async function main(): Promise<number> {
  let target = opt("target");
  let stop: (() => void) | undefined;

  if (flag("spawn") || !target) {
    const { createServer } = await import("../src/server/http.ts");
    const server = createServer({ testHooks: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => server.close();
  }

  const filter = opt("filter");
  const cases = CASES.filter((c) => !filter || c.id.includes(filter) || c.category === filter);
  const client = new Client(target);

  console.log("");
  console.log(`  ${magenta("◆")} ${bold("OICT conformance")} ${dim("v0.2.0")}`);
  console.log(`  ${dim("target")} ${cyan(target)}  ${dim("cases")} ${cases.length}`);

  const health = await client.get("/healthz").catch(() => null);
  if (!health || health.status !== 200) {
    console.log(red(`\n  ✘ target is not reachable at ${target}/healthz\n`));
    stop?.();
    return 2;
  }

  const compact = flag("compact");
  const outcomes: Outcome[] = [];
  let lastCat: Category | undefined;
  const t0 = performance.now();
  const printCategory = (cat: Category) => {
    const rows = outcomes.filter((o) => o.category === cat);
    const ok = rows.filter((o) => o.status === "pass").length;
    const ms = rows.reduce((s, o) => s + o.ms, 0);
    const dots = rows.map((o) => (o.status === "pass" ? green("■") : red("■"))).join("");
    const mark = ok === rows.length ? green("✔") : red("✘");
    console.log(`  ${mark} ${CATEGORY_TITLES[cat].padEnd(34)} ${`${ok}/${rows.length}`.padStart(5)}  ${dots}${" ".repeat(Math.max(0, 9 - rows.length))} ${dim(`${ms}ms`)}`);
    for (const o of rows) if (o.error) console.log(`      ${red("↳")} ${dim(o.id)} ${red(o.error)}`);
  };
  if (compact) console.log("");

  for (const c of cases) {
    if (c.category !== lastCat) {
      if (compact && lastCat) printCategory(lastCat);
      lastCat = c.category;
      if (!compact) console.log(`\n  ${bold(CATEGORY_TITLES[c.category])}`);
    }
    const start = performance.now();
    let error: string | undefined;
    try {
      await c.run(client);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ms = Math.round(performance.now() - start);
    outcomes.push({ id: c.id, category: c.category, rule: c.rule, title: c.title, status: error ? "fail" : "pass", ms, error });
    if (compact) continue;
    const mark = error ? red("✘") : green("✔");
    console.log(`    ${mark} ${dim(c.id)}  ${c.title} ${dim(`${ms}ms`)}`);
    if (error) console.log(`      ${red("↳")} ${red(error)}`);
  }
  if (compact && lastCat) printCategory(lastCat);

  const passed = outcomes.filter((o) => o.status === "pass").length;
  const failed = outcomes.length - passed;
  const total = Math.round(performance.now() - t0);
  const width = 32;
  const filled = Math.round((passed / Math.max(outcomes.length, 1)) * width);
  const bar = green("█".repeat(filled)) + red("█".repeat(width - filled));

  console.log("");
  console.log(`  ${bar}  ${bold(`${passed}/${outcomes.length}`)} passed ${dim(`in ${total}ms`)}`);
  console.log(failed ? red(`  ✘ ${failed} failing — not conformant\n`) : green(`  ✔ conformant with OICT v0.1 core profile\n`));

  const jsonOut = opt("json");
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify({ suite: "oict-conformance", version: "0.2.0", target, passed, failed, durationMs: total, outcomes }, null, 2),
    );
    console.log(dim(`  report written to ${jsonOut}\n`));
  }

  stop?.();
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
