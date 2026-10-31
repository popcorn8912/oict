#!/usr/bin/env node
/**
 * OICT reference server.
 *
 *   PORT                    listen port (default 8787; 0 = pick a free port)
 *   OICT_DATABASE_URL       postgres://user:pass@host:5432/db  → PostgresStore (else in-memory)
 *   OICT_SIGNING_KEY        Ed25519 key: 64 hex characters (seed) or PEM. Signs confirmations and
 *                           access tokens. Required with a database: every instance must share it.
 *   OICT_SIGNING_KEY_FILE   read the signing key from a file instead
 *   OICT_TRUSTED_JWKS_FILE  extra public keys to accept (key rotation, external token issuer)
 *   OICT_ISSUER             iss of tokens this server signs (default urn:oict:reference)
 *   OICT_TRUSTED_ISSUERS    comma-separated issuers whose access tokens are accepted (default: OICT_ISSUER)
 *   OICT_AUDIENCE           required aud of access tokens (default oict)
 *   OICT_ACCESS_TOKEN_TTL   access token lifetime in seconds (default 900)
 *   OICT_DB_POOL_SIZE       connections per instance (default 10)
 *   OICT_INSTANCE_ID        name reported in /healthz, logs, metrics and audit events
 *   OICT_LOG                json (default) | off
 *   OICT_TEST_HOOKS=1       expose /v1/_test/* fixture endpoints (never in production)
 *   OICT_ALLOW_GRANT_HEADER=1  accept the legacy "Authorization: OICT-Grant <id>" (never in production)
 */
import type { AddressInfo } from "node:net";
import { SYNTHETIC_CATALOG } from "../core/fixtures.ts";
import { KeyRing } from "../core/jose.ts";
import type { Store } from "../store/store.ts";
import { createServer, VERSION } from "./http.ts";
import { jsonLogger } from "./observability.ts";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const testHooks = env.OICT_TEST_HOOKS === "1" || process.argv.includes("--test-hooks");
const c = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

async function main() {
  let keys: KeyRing | undefined;
  try {
    keys = KeyRing.fromEnv(env);
  } catch (e) {
    fail(`invalid signing key: ${(e as Error).message}`);
  }
  if (env.OICT_SECRET && !env.OICT_SIGNING_KEY && !env.OICT_SIGNING_KEY_FILE) {
    console.error("note: OICT_SECRET is deprecated; it is used as the Ed25519 seed. Rename it to OICT_SIGNING_KEY.");
  }

  let store: Store | undefined;
  if (env.OICT_DATABASE_URL) {
    if (!keys) fail("OICT_SIGNING_KEY is required with OICT_DATABASE_URL: all instances must sign and verify with the same key.");
    const { PostgresStore } = await import("../store/postgres/store.ts");
    store = await PostgresStore.connect(env.OICT_DATABASE_URL, SYNTHETIC_CATALOG, { poolSize: Number(env.OICT_DB_POOL_SIZE ?? 10) });
  }

  const issuer = env.OICT_ISSUER;
  const server = createServer({
    testHooks,
    instanceId: env.OICT_INSTANCE_ID,
    log: env.OICT_LOG === "off" ? undefined : jsonLogger,
    engine: {
      store,
      keys,
      issuer,
      trustedIssuers: env.OICT_TRUSTED_ISSUERS?.split(",").map((s) => s.trim()).filter(Boolean),
      audience: env.OICT_AUDIENCE,
      accessTokenTtlSeconds: env.OICT_ACCESS_TOKEN_TTL ? Number(env.OICT_ACCESS_TOKEN_TTL) : undefined,
      allowGrantHeader: env.OICT_ALLOW_GRANT_HEADER === "1",
    },
  });

  server.listen(port, () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(
      [
        "",
        c(35, "  ◆ OICT reference server") + c(90, `  v${VERSION}`),
        c(90, "  ─────────────────────────────────────"),
        `  ${c(36, "→")} listening on http://localhost:${actual}`,
        `  ${c(36, "→")} store: ${store ? c(32, "postgres") : c(33, "memory (single instance)")}`,
        `  ${c(36, "→")} signing key: ${keys ? c(32, "configured") : c(33, "ephemeral (single instance)")}`,
        `  ${c(36, "→")} metrics: /metrics   keys: /.well-known/jwks.json`,
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
