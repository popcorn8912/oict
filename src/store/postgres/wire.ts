/**
 * A small, dependency-free PostgreSQL client speaking the v3 wire protocol.
 *
 * Scope is deliberately narrow — exactly what the OICT reference server needs:
 *   • startup with SCRAM-SHA-256, MD5 or cleartext password authentication
 *   • optional TLS (sslmode=require | verify-full)
 *   • parameterised queries over the extended-query protocol (text format)
 *   • typed result rows for the column types OICT uses
 *   • a connection pool with explicit checkout for transactions
 *
 * The pool exposes the same `query(text, values)` / `connect()` / `release()`
 * shape as node-postgres, so a production deployment can pass a `pg.Pool`
 * to `PostgresStore` instead.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
  command: string;
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface PoolClient extends Queryable {
  release(err?: unknown): void;
}

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  sslmode: "disable" | "require" | "verify-full";
  applicationName: string;
}

export class PgError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly constraint?: string;
  readonly severity?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? "PostgreSQL error");
    this.name = "PgError";
    this.code = fields.C ?? "XX000";
    this.detail = fields.D;
    this.constraint = fields.n;
    this.severity = fields.V ?? fields.S;
  }
}

export function parseConnectionString(url: string): ConnectionConfig {
  const u = new URL(url);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("connection string must start with postgres:// or postgresql://");
  }
  const sslmode = (u.searchParams.get("sslmode") ?? "disable") as ConnectionConfig["sslmode"];
  if (!["disable", "require", "verify-full"].includes(sslmode)) {
    throw new Error(`unsupported sslmode ${sslmode} (use disable, require or verify-full)`);
  }
  return {
    host: decodeURIComponent(u.hostname) || "localhost",
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username) || "postgres",
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    sslmode,
    applicationName: u.searchParams.get("application_name") ?? "oict",
  };
}

// ───────────────────────────── message encoding ─────────────────────────────

class Writer {
  private parts: Buffer[] = [];
  int16(n: number) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    this.parts.push(b);
    return this;
  }
  int32(n: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    this.parts.push(b);
    return this;
  }
  cstr(s: string) {
    this.parts.push(Buffer.from(s, "utf8"), Buffer.from([0]));
    return this;
  }
  bytes(b: Buffer) {
    this.parts.push(b);
    return this;
  }
  /** Frame as a typed message: 1-byte type + int32 length (incl. itself) + body. */
  frame(type: string): Buffer {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(5);
    head.write(type, 0, "ascii");
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  }
  /** Untyped frame (startup / SSLRequest): int32 length + body. */
  frameUntyped(): Buffer {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(4);
    head.writeInt32BE(body.length + 4);
    return Buffer.concat([head, body]);
  }
}

function encodeParam(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return Buffer.from(v ? "t" : "f");
  if (typeof v === "number" || typeof v === "bigint") return Buffer.from(String(v));
  if (typeof v === "string") return Buffer.from(v, "utf8");
  if (v instanceof Date) return Buffer.from(v.toISOString());
  return Buffer.from(JSON.stringify(v), "utf8");
}

// Type OIDs we decode; everything else stays a string.
const OID = { bool: 16, int8: 20, int2: 21, int4: 23, oid: 26, json: 114, float4: 700, float8: 701, numeric: 1700, jsonb: 3802 };

function decodeValue(oid: number, raw: string): unknown {
  switch (oid) {
    case OID.bool:
      return raw === "t";
    case OID.int2:
    case OID.int4:
    case OID.oid:
    case OID.int8:
    case OID.float4:
    case OID.float8:
    case OID.numeric:
      return Number(raw);
    case OID.json:
    case OID.jsonb:
      return JSON.parse(raw);
    default:
      return raw;
  }
}

// ───────────────────────────── SCRAM-SHA-256 ─────────────────────────────

const hmac = (key: Buffer, msg: string) => createHmac("sha256", key).update(msg).digest();
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

class Scram {
  private readonly clientNonce = randomBytes(18).toString("base64");
  private readonly clientFirstBare = `n=*,r=${this.clientNonce}`;
  private serverSignature?: Buffer;
  private readonly password: string;
  constructor(password: string) {
    this.password = password;
  }

  initial(): Buffer {
    return Buffer.from(`n,,${this.clientFirstBare}`);
  }

  continue(serverFirst: string): Buffer {
    const attrs = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
    const nonce = attrs.r, salt = attrs.s, iterations = Number(attrs.i);
    if (!nonce?.startsWith(this.clientNonce) || !salt || !(iterations > 0)) {
      throw new Error("SCRAM: invalid server-first-message");
    }
    const salted = pbkdf2Sync(this.password.normalize("NFKC"), Buffer.from(salt, "base64"), iterations, 32, "sha256");
    const clientKey = hmac(salted, "Client Key");
    const finalNoProof = `c=biws,r=${nonce}`;
    const authMessage = `${this.clientFirstBare},${serverFirst},${finalNoProof}`;
    const signature = hmac(sha256(clientKey), authMessage);
    const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]!));
    this.serverSignature = hmac(hmac(salted, "Server Key"), authMessage);
    return Buffer.from(`${finalNoProof},p=${proof.toString("base64")}`);
  }

  verify(serverFinal: string): void {
    const v = serverFinal.split(",").find((p) => p.startsWith("v="))?.slice(2);
    const got = v ? Buffer.from(v, "base64") : Buffer.alloc(0);
    if (!this.serverSignature || got.length !== this.serverSignature.length || !timingSafeEqual(got, this.serverSignature)) {
      throw new Error("SCRAM: server signature mismatch");
    }
  }
}

// ───────────────────────────── connection ─────────────────────────────

interface Pending {
  resolve: (r: QueryResult) => void;
  reject: (e: unknown) => void;
  fields: { name: string; oid: number }[];
  rows: Record<string, unknown>[];
  command: string;
  error?: PgError;
}

export class Connection implements Queryable {
  private socket!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: { text: string; values: unknown[]; pending: Pending }[] = [];
  private current?: Pending;
  private ready = false;
  private closed = false;
  private onReady?: (err?: unknown) => void;
  private scram?: Scram;
  readonly params: Record<string, string> = {};
  private readonly cfg: ConnectionConfig;

  private constructor(cfg: ConnectionConfig) {
    this.cfg = cfg;
  }

  static async open(cfg: ConnectionConfig): Promise<Connection> {
    const c = new Connection(cfg);
    await c.start();
    return c;
  }

  private async start(): Promise<void> {
    let sock: net.Socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host: this.cfg.host, port: this.cfg.port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    sock.setNoDelay(true);

    if (this.cfg.sslmode !== "disable") {
      sock.write(new Writer().int32(80877103).frameUntyped());
      const answer: string = await new Promise((resolve, reject) => {
        sock.once("data", (d) => resolve(d.toString("ascii", 0, 1)));
        sock.once("error", reject);
      });
      if (answer !== "S") throw new Error("server does not support TLS");
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({
          socket: sock,
          servername: net.isIP(this.cfg.host) ? undefined : this.cfg.host,
          rejectUnauthorized: this.cfg.sslmode === "verify-full",
        });
        t.once("secureConnect", () => resolve(t));
        t.once("error", reject);
      });
    }

    this.socket = sock;
    sock.on("data", (d) => this.onData(d));
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new Error("connection closed")));

    const startup = new Writer()
      .int32(196608)
      .cstr("user").cstr(this.cfg.user)
      .cstr("database").cstr(this.cfg.database)
      .cstr("application_name").cstr(this.cfg.applicationName)
      .cstr("client_encoding").cstr("UTF8")
      .bytes(Buffer.from([0]))
      .frameUntyped();

    await new Promise<void>((resolve, reject) => {
      this.onReady = (err) => (err ? reject(err) : resolve());
      sock.write(startup);
    });
  }

  private fail(err: unknown) {
    if (this.closed) return;
    this.closed = true;
    this.onReady?.(err);
    this.onReady = undefined;
    this.current?.reject(err);
    for (const q of this.queue) q.pending.reject(err);
    this.queue = [];
    this.current = undefined;
  }

  get isClosed() {
    return this.closed;
  }

  query<R = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    if (this.closed) return Promise.reject(new Error("connection is closed"));
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (r: QueryResult) => void, reject, fields: [], rows: [], command: "" };
      this.queue.push({ text, values, pending });
      this.pump();
    });
  }

  private pump() {
    if (!this.ready || this.current || this.queue.length === 0) return;
    const { text, values, pending } = this.queue.shift()!;
    this.current = pending;
    this.ready = false;

    const bind = new Writer().cstr("").cstr("").int16(0).int16(values.length);
    for (const v of values) {
      const enc = encodeParam(v);
      if (enc === null) bind.int32(-1);
      else bind.int32(enc.length).bytes(enc);
    }
    bind.int16(0);

    this.socket.write(
      Buffer.concat([
        new Writer().cstr("").cstr(text).int16(0).frame("P"),
        bind.frame("B"),
        new Writer().bytes(Buffer.from("P", "ascii")).cstr("").frame("D"),
        new Writer().cstr("").int32(0).frame("E"),
        new Writer().frame("S"),
      ]),
    );
  }

  private onData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]!);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try {
        this.handle(type, body);
      } catch (e) {
        this.fail(e);
        this.socket.destroy();
        return;
      }
    }
  }

  private handle(type: string, body: Buffer) {
    switch (type) {
      case "R":
        return this.auth(body);
      case "S": {
        const [k, v] = body.toString("utf8").split("\0");
        if (k) this.params[k] = v ?? "";
        return;
      }
      case "K":
      case "1":
      case "2":
      case "n":
      case "N":
      case "s":
      case "I":
        return;
      case "T": {
        const count = body.readInt16BE(0);
        let off = 2;
        const fields: Pending["fields"] = [];
        for (let i = 0; i < count; i++) {
          const end = body.indexOf(0, off);
          const name = body.toString("utf8", off, end);
          off = end + 1;
          const oid = body.readInt32BE(off + 6);
          off += 18;
          fields.push({ name, oid });
        }
        if (this.current) this.current.fields = fields;
        return;
      }
      case "D": {
        if (!this.current) return;
        const count = body.readInt16BE(0);
        let off = 2;
        const row: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const n = body.readInt32BE(off);
          off += 4;
          const f = this.current.fields[i]!;
          if (n === -1) row[f.name] = null;
          else {
            row[f.name] = decodeValue(f.oid, body.toString("utf8", off, off + n));
            off += n;
          }
        }
        this.current.rows.push(row);
        return;
      }
      case "C":
        if (this.current) this.current.command = body.toString("utf8", 0, body.length - 1);
        return;
      case "E": {
        const fields: Record<string, string> = {};
        let off = 0;
        while (off < body.length && body[off] !== 0) {
          const code = String.fromCharCode(body[off]!);
          const end = body.indexOf(0, off + 1);
          fields[code] = body.toString("utf8", off + 1, end);
          off = end + 1;
        }
        const err = new PgError(fields);
        if (this.current) this.current.error = err;
        else if (this.onReady) {
          this.onReady(err);
          this.onReady = undefined;
        }
        return;
      }
      case "Z": {
        this.ready = true;
        if (this.onReady) {
          this.onReady();
          this.onReady = undefined;
        }
        const done = this.current;
        this.current = undefined;
        if (done) {
          if (done.error) done.reject(done.error);
          else {
            const m = /(\d+)$/.exec(done.command);
            done.resolve({ rows: done.rows, rowCount: m ? Number(m[1]) : done.rows.length, command: done.command.split(" ")[0] ?? "" });
          }
        }
        this.pump();
        return;
      }
      default:
        throw new Error(`unexpected message type ${JSON.stringify(type)}`);
    }
  }

  private auth(body: Buffer) {
    const kind = body.readInt32BE(0);
    const password = this.cfg.password;
    const need = () => {
      if (password === undefined) throw new Error("server requested a password but none was provided");
      return password;
    };
    switch (kind) {
      case 0:
        return; // AuthenticationOk
      case 3:
        this.socket.write(new Writer().cstr(need()).frame("p"));
        return;
      case 5: {
        const salt = body.subarray(4, 8);
        const inner = createHash("md5").update(need() + this.cfg.user).digest("hex");
        const outer = createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");
        this.socket.write(new Writer().cstr(`md5${outer}`).frame("p"));
        return;
      }
      case 10: {
        const mechanisms = body.subarray(4).toString("utf8").split("\0").filter(Boolean);
        if (!mechanisms.includes("SCRAM-SHA-256")) throw new Error(`unsupported SASL mechanisms: ${mechanisms.join(", ")}`);
        this.scram = new Scram(need());
        const first = this.scram.initial();
        this.socket.write(new Writer().cstr("SCRAM-SHA-256").int32(first.length).bytes(first).frame("p"));
        return;
      }
      case 11:
        this.socket.write(new Writer().bytes(this.scram!.continue(body.subarray(4).toString("utf8"))).frame("p"));
        return;
      case 12:
        this.scram!.verify(body.subarray(4).toString("utf8"));
        return;
      default:
        throw new Error(`unsupported authentication method ${kind}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.end(new Writer().frame("X"));
    });
  }
}

// ───────────────────────────── pool ─────────────────────────────

export class Pool implements Queryable {
  private readonly cfg: ConnectionConfig;
  private readonly max: number;
  private idle: Connection[] = [];
  private all = new Set<Connection>();
  private waiters: ((c: Connection) => void)[] = [];
  private opening = 0;
  private ended = false;

  constructor(connectionString: string, opts: { max?: number } = {}) {
    this.cfg = parseConnectionString(connectionString);
    this.max = opts.max ?? 10;
  }

  private async acquire(): Promise<Connection> {
    if (this.ended) throw new Error("pool has ended");
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.isClosed) return c;
      this.all.delete(c);
    }
    if (this.all.size + this.opening < this.max) {
      this.opening++;
      try {
        const c = await Connection.open(this.cfg);
        this.all.add(c);
        return c;
      } finally {
        this.opening--;
      }
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private giveBack(c: Connection, broken: boolean) {
    if (broken || c.isClosed || this.ended) {
      this.all.delete(c);
      void c.close().catch(() => {});
      const w = this.waiters.shift();
      if (w && !this.ended) this.acquire().then(w, () => {});
      return;
    }
    const w = this.waiters.shift();
    if (w) w(c);
    else this.idle.push(c);
  }

  async connect(): Promise<PoolClient> {
    const c = await this.acquire();
    let released = false;
    return {
      query: (text, values) => c.query(text, values),
      release: (err?: unknown) => {
        if (released) return;
        released = true;
        this.giveBack(c, Boolean(err));
      },
    };
  }

  async query<R = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    const c = await this.acquire();
    try {
      const r = await c.query<R>(text, values);
      this.giveBack(c, false);
      return r;
    } catch (e) {
      this.giveBack(c, !(e instanceof PgError));
      throw e;
    }
  }

  async end(): Promise<void> {
    this.ended = true;
    await Promise.all([...this.all].map((c) => c.close().catch(() => {})));
    this.all.clear();
    this.idle = [];
  }
}
