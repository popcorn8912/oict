#!/usr/bin/env node
/**
 * OICT reference server.
 *
 *   PORT                 listen port (default 8787; 0 = pick a free port)
 *   OICT_DATABASE_URL    postgres://user:pass@host:5432/db  → PostgresStore (else in-memory)
 *   OICT_SECRET          confirmation-token signing key, ≥ 32 bytes as hex or base64.
 *                        Required with a database: every instance must share it.
 *   OICT_DB_POOL_SIZE    connections per instance (default 10)
 *   OICT_INSTANCE_ID     name reported in /healthz and X-OICT-Instance
 *   OICT_TEST_HOOKS=1    expose /v1/_test/* fixture endpoints (never in production)
 */
import type { AddressInfo } from "node:net";
import { SYNTHETIC_CATALOG } from "../core/fixtures.ts";
import type { Store } from "../store/store.ts";
import { createServer, VERSION } from "./http.ts";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const testHooks = env.OICT_TEST_HOOKS === "1" || process.argv.includes("--test-hooks");
const c = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

function parseSecret(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  const buf = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length < 32) {
    console.error("OICT_SECRET must decode to at least 32 bytes (64 hex characters)");
    process.exit(1);
  }
  return buf;
}

async function main() {
  const secret = parseSecret(env.OICT_SECRET);
  let store: Store | undefined;

  if (env.OICT_DATABASE_URL) {
    if (!secret) {
      console.error("OICT_SECRET is required with OICT_DATABASE_URL: all instances must sign confirmations with the same key.");
      process.exit(1);
    }
    const { PostgresStore } = await import("../store/postgres/store.ts");
    store = await PostgresStore.connect(env.OICT_DATABASE_URL, SYNTHETIC_CATALOG, {
      poolSize: Number(env.OICT_DB_POOL_SIZE ?? 10),
    });
  }

  const server = createServer({ testHooks, engine: { store, secret }, instanceId: env.OICT_INSTANCE_ID });
  server.listen(port, () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(
      [
        "",
        c(35, "  ◆ OICT reference server") + c(90, `  v${VERSION}`),
        c(90, "  ─────────────────────────────────────"),
        `  ${c(36, "→")} listening on http://localhost:${actual}`,
        `  ${c(36, "→")} store: ${store ? c(32, "postgres") : c(33, "memory (single instance)")}`,
        `  ${c(36, "→")} test hooks: ${testHooks ? c(32, "on") : c(90, "off")}`,
        `  ${c(36, "→")} data: ${c(33, "synthetic catalog only")}`,
        "",
      ].join("\n"),
    );
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(c(90, `  ${signal} received, draining connections…`));
    server.close(async () => {
      await store?.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
