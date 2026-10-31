import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { digest } from "../core/crypto.ts";
import { OictEngine, type EngineOptions } from "../core/engine.ts";
import { SYNTHETIC_CATALOG } from "../core/fixtures.ts";
import { OictError } from "../core/types.ts";
import { MemoryStore } from "../store/memory.ts";
import { serverMetrics, type LogFn } from "./observability.ts";

export const VERSION = "0.3.0";

export interface ServerOptions {
  /** Expose /v1/_test/* fixture endpoints used by the conformance suite. */
  testHooks?: boolean;
  /** Engine settings. `store` defaults to a MemoryStore seeded with the synthetic catalog. */
  engine?: Omit<EngineOptions, "now" | "catalog" | "auditContext">;
  /** Reported in /healthz, metrics, logs, audit events and the X-OICT-Instance header. */
  instanceId?: string;
  /** Receives one structured entry per request. Omit to disable access logs. */
  log?: LogFn;
}

type Json = Record<string, unknown>;
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

class RawBody {
  readonly contentType: string;
  readonly text: string;
  constructor(contentType: string, text: string) {
    this.contentType = contentType;
    this.text = text;
  }
}

interface Ctx {
  engine: OictEngine;
  params: Record<string, string>;
  body: Json;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  /** Authenticate the request (Bearer access token). Throws on failure. */
  caller: () => ReturnType<OictEngine["authenticate"]>;
  setHeader: (k: string, v: string) => void;
  setStatus: (s: number) => void;
  /** Return a non-JSON body. */
  raw: (contentType: string, text: string) => RawBody;
}

interface Route {
  method: string;
  template: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/[.]/g, "\\.").replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}$`,
  );
  return { method, template: path, pattern, keys, handler };
}

function str(body: Json, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v) throw new OictError("BAD_REQUEST", `${key} must be a non-empty string`);
  return v;
}

interface RequestContext {
  requestId: string;
  instance: string;
}

/** Create the OICT reference HTTP server. Call `.listen(port)` to start it. */
export function createServer(opts: ServerOptions = {}): http.Server {
  let clockOffset = 0;
  const instanceId = opts.instanceId ?? `oict-${randomBytes(3).toString("hex")}`;
  const store = opts.engine?.store ?? new MemoryStore(SYNTHETIC_CATALOG);
  const als = new AsyncLocalStorage<RequestContext>();
  const engine = new OictEngine({
    ...opts.engine,
    store,
    now: () => Date.now() + clockOffset,
    auditContext: () => {
      const c = als.getStore();
      return c ? { requestId: c.requestId, instance: c.instance } : { instance: instanceId };
    },
  });
  const metrics = serverMetrics(VERSION, store.kind, instanceId);
  const withToken = (grant: Awaited<ReturnType<OictEngine["issueGrant"]>>) => ({ ...grant, ...engine.issueAccessToken(grant) });

  const routes: Route[] = [
    route("GET", "/healthz", () => ({ status: "ok", spec: "OICT", version: VERSION, store: store.kind, instance: instanceId })),
    route("GET", "/metrics", ({ raw }) => raw("text/plain; version=0.0.4; charset=utf-8", metrics.registry.render())),
    route("GET", "/.well-known/jwks.json", () => engine.keys.jwks()),
    route("GET", "/v1/catalog", async ({ engine }) => ({ items: await engine.listCatalog() })),

    route("POST", "/v1/participants", ({ engine, body, setStatus }) => {
      setStatus(201);
      return engine.registerParticipant({
        id: str(body, "id"),
        kind: str(body, "kind") as never,
        ageBand: body.ageBand as never,
        displayName: body.displayName as string | undefined,
        platformId: body.platformId as string | undefined,
        developerId: body.developerId as string | undefined,
      });
    }),

    // Grants come back with an access token for their subject: the reference
    // server doubles as the authorization server. Production deployments can
    // trust an external issuer instead (see docs/deployment.md).
    route("POST", "/v1/grants", async ({ engine, body, setStatus }) => {
      const grant = await engine.issueGrant({
        issuer: str(body, "issuer"),
        subject: str(body, "subject"),
        application: str(body, "application"),
        scopes: body.scopes as never,
        ttlSeconds: Number(body.ttlSeconds ?? 3600),
        parentGrantId: body.parentGrantId as string | undefined,
        guardianConsentRef: body.guardianConsentRef as string | undefined,
        maxOrderTotalMinor: body.maxOrderTotalMinor as number | undefined,
      });
      setStatus(201);
      return withToken(grant);
    }),

    route("POST", "/v1/grants/:id/revoke", ({ engine, params, body }) => engine.revokeGrant(params.id!, str(body, "by"))),

    route("POST", "/v1/sessions", ({ engine, body, setStatus }) => {
      setStatus(201);
      return engine.createSession(str(body, "consumerId"), str(body, "applicationId"));
    }),

    route("GET", "/v1/sessions/:id", async ({ engine, params }) => {
      const session = await engine.session(params.id!);
      if (!session.selection) return { session, snapshot: null, snapshotHash: null };
      const snapshot = await engine.snapshot(session);
      return { session, snapshot, snapshotHash: digest(snapshot) };
    }),

    route("POST", "/v1/sessions/:id/selection", async ({ engine, params, body }) => {
      const { session, snapshot, snapshotHash } = await engine.updateSelection(params.id!, {
        sceneObjectId: str(body, "sceneObjectId"),
        sku: str(body, "sku"),
        variantId: str(body, "variantId"),
        quantity: Number(body.quantity ?? 1),
      });
      return { stateVersion: session.stateVersion, snapshot, snapshotHash };
    }),

    route("POST", "/v1/carts", async ({ engine, body, caller, setStatus }) => {
      const cart = await engine.prepareCart(caller(), str(body, "sessionId"), Number(body.stateVersion));
      setStatus(201);
      return cart;
    }),

    route("POST", "/v1/confirmations", async ({ engine, body, setStatus }) => {
      const { token, claims } = await engine.confirm({
        sessionId: str(body, "sessionId"),
        consumerId: str(body, "consumerId"),
        snapshotHash: str(body, "snapshotHash"),
        guardianConsentRef: body.guardianConsentRef as string | undefined,
      });
      setStatus(201);
      return { confirmationToken: token, expiresAt: claims.exp, totalMinor: claims.totalMinor, currency: claims.currency };
    }),

    route("POST", "/v1/orders", async ({ engine, body, caller, headers, setHeader, setStatus }) => {
      const key = headers["idempotency-key"];
      const who = caller();
      const { order, replayed } = await engine.placeOrder({
        grantId: who.grantId,
        subject: who.subject,
        scopes: who.scopes,
        idempotencyKey: Array.isArray(key) ? key[0] : key,
        sessionId: str(body, "sessionId"),
        confirmationToken: str(body, "confirmationToken"),
      });
      metrics.orders.inc({ result: replayed ? "replayed" : "created" });
      setHeader("OICT-Idempotent-Replay", String(replayed));
      setStatus(replayed ? 200 : 201);
      return order;
    }),

    route("GET", "/v1/orders/:id", ({ engine, params, caller }) => engine.getOrder(params.id!, caller())),

    route("GET", "/v1/audit", async ({ engine, caller, query }) => ({
      events: await engine.listAudit(caller(), Number(query.get("limit") ?? 50)),
    })),
  ];

  if (opts.testHooks) {
    routes.push(
      route("POST", "/v1/_test/reset", async () => {
        clockOffset = 0;
        await store.reset(SYNTHETIC_CATALOG);
        return { reset: true };
      }),
      route("POST", "/v1/_test/clock", ({ body }) => {
        clockOffset += Number(body.advanceSeconds ?? 0) * 1000;
        return { offsetSeconds: clockOffset / 1000 };
      }),
      route("POST", "/v1/_test/price", ({ engine, body }) =>
        engine.setPrice(str(body, "sku"), str(body, "variantId"), Number(body.unitPriceMinor)),
      ),
    );
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, requestId: string) {
    const started = process.hrtime.bigint();
    let template = "unmatched";
    let errorCode: string | undefined;
    let subject: string | undefined;

    const finish = (status: number, contentType: string, payload: string) => {
      res.writeHead(status, {
        "content-type": contentType,
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, idempotency-key, x-request-id",
        "access-control-expose-headers": "oict-idempotent-replay, x-oict-instance, x-request-id",
        "x-oict-version": VERSION,
        "x-oict-instance": instanceId,
        "x-request-id": requestId,
      });
      res.end(payload);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const method = req.method ?? "GET";
      metrics.requests.inc({ method, route: template, status: String(status) });
      metrics.duration.observe(seconds, { route: template });
      if (errorCode) metrics.refusals.inc({ code: errorCode });
      opts.log?.({
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        msg: "request",
        instance: instanceId,
        requestId,
        method,
        route: template,
        status,
        durationMs: Math.round(seconds * 1e4) / 10,
        ...(subject ? { subject } : {}),
        ...(errorCode ? { code: errorCode } : {}),
      });
    };
    const sendJson = (status: number, payload: unknown) => finish(status, "application/json; charset=utf-8", JSON.stringify(payload));

    if (req.method === "OPTIONS") return sendJson(204, {});

    const url = new URL(req.url ?? "/", "http://localhost");
    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null }))
      .find((x) => x.m);
    if (!match?.m) {
      errorCode = "NOT_FOUND";
      return sendJson(404, { error: { code: "NOT_FOUND", message: `no route ${req.method} ${url.pathname}` } });
    }
    template = match.r.template;

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        errorCode = "BAD_REQUEST";
        return sendJson(413, { error: { code: "BAD_REQUEST", message: "body too large" } });
      }
    }
    let body: Json = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Json;
      } catch {
        errorCode = "BAD_REQUEST";
        return sendJson(400, { error: { code: "BAD_REQUEST", message: "body must be a JSON object" } });
      }
    }

    const params: Record<string, string> = {};
    match.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match.m![i + 1]!)));

    let status = 200;
    const extraHeaders: Record<string, string> = {};
    try {
      const result = await match.r.handler({
        engine,
        params,
        body,
        query: url.searchParams,
        headers: req.headers,
        caller: () => {
          const c = engine.authenticate(req.headers.authorization);
          subject = c.subject;
          return c;
        },
        setHeader: (k, v) => (extraHeaders[k] = v),
        setStatus: (s) => (status = s),
        raw: (contentType, text) => new RawBody(contentType, text),
      });
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      if (result instanceof RawBody) return finish(status, result.contentType, result.text);
      sendJson(status, result);
    } catch (err) {
      if (err instanceof OictError) {
        errorCode = err.code;
        return sendJson(err.status, { error: { code: err.code, message: err.message } });
      }
      opts.log?.({ level: "error", msg: "unhandled error", instance: instanceId, requestId, error: String((err as Error)?.stack ?? err) });
      if (!opts.log) console.error(err);
      sendJson(500, { error: { code: "INTERNAL", message: "internal error" } });
    }
  }

  return http.createServer((req, res) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : `req_${randomBytes(9).toString("base64url")}`;
    als.run({ requestId, instance: instanceId }, () => void handle(req, res, requestId));
  });
}
