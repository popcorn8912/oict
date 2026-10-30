/**
 * Test harness: a throw-away PostgreSQL database plus N independent OICT
 * server processes pointed at it — the same topology as a horizontally
 * scaled deployment behind a load balancer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "../../src/store/postgres/wire.ts";

const MAIN = fileURLToPath(new URL("../../src/server/main.ts", import.meta.url));

export interface TempDatabase {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

/** Create a fresh database next to the one in `adminUrl`; drop it afterwards. */
export async function createTempDatabase(adminUrl: string): Promise<TempDatabase> {
  const name = `oict_test_${randomBytes(4).toString("hex")}`;
  const admin = new Pool(adminUrl, { max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = new Pool(url, { max: 4 });
  return {
    url,
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface Cluster {
  urls: string[];
  stop(): Promise<void>;
}

export async function startCluster(opts: {
  databaseUrl: string;
  instances: number;
  secret?: string;
  poolSize?: number;
  testHooks?: boolean;
}): Promise<Cluster> {
  const secret = opts.secret ?? randomBytes(32).toString("hex");
  const children: ChildProcess[] = [];
  const stop = async () => {
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.exitCode !== null) return resolve();
            c.once("exit", () => resolve());
            c.kill("SIGTERM");
            setTimeout(() => c.kill("SIGKILL"), 4000).unref();
          }),
      ),
    );
  };

  try {
    // Start every instance at once: migrations must be safe under a concurrent rollout.
    const urls = await Promise.all(
      Array.from({ length: opts.instances }, (_, i) => {
        const child = spawn(process.execPath, [MAIN], {
          env: {
            ...process.env,
            PORT: "0",
            NO_COLOR: "1",
            OICT_DATABASE_URL: opts.databaseUrl,
            OICT_SECRET: secret,
            OICT_INSTANCE_ID: `node-${i + 1}`,
            OICT_DB_POOL_SIZE: String(opts.poolSize ?? 10),
            OICT_TEST_HOOKS: opts.testHooks === false ? "0" : "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        return new Promise<string>((resolve, reject) => {
          let out = "";
          let err = "";
          const timer = setTimeout(() => reject(new Error(`node-${i + 1} did not start:\n${out}${err}`)), 20000);
          child.stdout!.on("data", (d) => {
            out += d;
            const m = /listening on http:\/\/localhost:(\d+)/.exec(out);
            if (m) {
              clearTimeout(timer);
              resolve(`http://127.0.0.1:${m[1]}`);
            }
          });
          child.stderr!.on("data", (d) => (err += d));
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`node-${i + 1} exited with ${code}:\n${out}${err}`));
          });
        });
      }),
    );
    return { urls, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

export interface Reply {
  status: number;
  body: any;
  instance: string | null;
  ms: number;
}

export async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const t0 = performance.now();
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : undefined,
    instance: res.headers.get("x-oict-instance"),
    ms: performance.now() - t0,
  };
}
