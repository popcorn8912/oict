/**
 * Minimal HTTP client + fixture builder used by every conformance case.
 * It talks only to the public OICT surface plus the /v1/_test fixture hooks.
 */

export interface Resp {
  status: number;
  body: any;
  headers: Headers;
}

export class Client {
  readonly base: string;
  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  post(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.req("POST", path, body ?? {}, headers);
  }
  get(path: string, headers?: Record<string, string>) {
    return this.req("GET", path, undefined, headers);
  }
}

export const auth = (grantId: string) => ({ authorization: `OICT-Grant ${grantId}` });
export const idem = (key: string) => ({ "idempotency-key": key });

let keyCounter = 0;
export const newKey = () => `key-${Date.now().toString(36)}-${(keyCounter++).toString(36)}-xyz`;

export type AgeBand = "under13" | "13-17" | "adult";

export interface World {
  c: Client;
  appId: string;
  otherAppId: string;
  consumerId: string;
  agentId: string;
  /** consumer → application, all scopes */
  appGrant: string;
  sessionId: string;
  snapshotHash: string;
  stateVersion: number;
}

/** Build a fresh, fully wired world: platform, developer, two apps, consumer, agent, grant, session. */
export async function world(c: Client, opts: { ageBand?: AgeBand; sku?: string; variantId?: string; appScopes?: string[] } = {}): Promise<World> {
  await must(c.post("/v1/_test/reset"), 200);
  await must(c.post("/v1/participants", { id: "plat", kind: "platform" }), 201);
  await must(c.post("/v1/participants", { id: "dev", kind: "developer" }), 201);
  await must(c.post("/v1/participants", { id: "app", kind: "application", platformId: "plat", developerId: "dev" }), 201);
  await must(c.post("/v1/participants", { id: "app2", kind: "application", platformId: "plat", developerId: "dev" }), 201);
  await must(c.post("/v1/participants", { id: "alice", kind: "consumer", ageBand: opts.ageBand ?? "adult" }), 201);
  await must(c.post("/v1/participants", { id: "bob", kind: "consumer", ageBand: "adult" }), 201);
  await must(c.post("/v1/participants", { id: "helper", kind: "agent" }), 201);

  const grant = await must(
    c.post("/v1/grants", {
      issuer: "alice",
      subject: "app",
      application: "app",
      scopes: opts.appScopes ?? ["catalog:read", "cart:write", "checkout:prepare", "order:place", "order:read"],
      ttlSeconds: 3600,
    }),
    201,
  );
  const session = await must(c.post("/v1/sessions", { consumerId: "alice", applicationId: "app" }), 201);
  const sel = await must(
    c.post(`/v1/sessions/${session.body.id}/selection`, {
      sceneObjectId: "obj-hoodie-rack",
      sku: opts.sku ?? "SYN-HOODIE-01",
      variantId: opts.variantId ?? "violet-m",
      quantity: 1,
    }),
    200,
  );
  return {
    c,
    appId: "app",
    otherAppId: "app2",
    consumerId: "alice",
    agentId: "helper",
    appGrant: grant.body.id,
    sessionId: session.body.id,
    snapshotHash: sel.body.snapshotHash,
    stateVersion: sel.body.stateVersion,
  };
}

export async function confirm(w: World, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await must(
    w.c.post("/v1/confirmations", { sessionId: w.sessionId, consumerId: w.consumerId, snapshotHash: w.snapshotHash, ...extra }),
    201,
  );
  return r.body.confirmationToken as string;
}

export function order(w: World, token: string, key: string = newKey(), grant: string = w.appGrant): Promise<Resp> {
  return w.c.post("/v1/orders", { sessionId: w.sessionId, confirmationToken: token }, { ...auth(grant), ...idem(key) });
}

export class AssertionFailure extends Error {}

export async function must(p: Promise<Resp> | Resp, status: number): Promise<Resp> {
  const r = await p;
  if (r.status !== status) {
    throw new AssertionFailure(`expected HTTP ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r;
}

export async function expectError(p: Promise<Resp> | Resp, code: string, status?: number): Promise<Resp> {
  const r = await p;
  const got = r.body?.error?.code;
  if (got !== code || (status !== undefined && r.status !== status)) {
    throw new AssertionFailure(`expected ${code}${status ? ` (${status})` : ""}, got ${r.status} ${got ?? JSON.stringify(r.body)}`);
  }
  return r;
}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionFailure(message);
}
