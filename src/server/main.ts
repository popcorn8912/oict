#!/usr/bin/env node
import { createServer } from "./http.ts";

const port = Number(process.env.PORT ?? 8787);
const testHooks = process.env.OICT_TEST_HOOKS === "1" || process.argv.includes("--test-hooks");

const c = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

createServer({ testHooks }).listen(port, () => {
  console.log(
    [
      "",
      c(35, "  ◆ OICT reference server") + c(90, "  v0.1.0"),
      c(90, "  ─────────────────────────────────────"),
      `  ${c(36, "→")} http://localhost:${port}`,
      `  ${c(36, "→")} test hooks: ${testHooks ? c(32, "on") : c(90, "off")}`,
      `  ${c(36, "→")} data: ${c(33, "synthetic catalog only")}`,
      "",
    ].join("\n"),
  );
});
