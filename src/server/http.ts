import http from "node:http";
import { digest } from "../core/crypto.ts";
import { OictEngine, type EngineOptions } from "../core/engine.ts";
import { SYNTHETIC_CATALOG } from "../core/fixtures.ts";
import { OictError } from "../core/types.ts";

export interface ServerOptions {
  /** Expose /v1/_test/* fixture endpoints used by the conformance suite. */
  testHooks?: boolean;
  engine?: Omit<EngineOptions, "now" | "catalog">;
}

type Json = Record<string, unknown>;
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Ctx {
  engine: OictEngine;
  params: Record<string, string>;
  body: Json;
  grantId?: string;
  headers: http.IncomingHttpHeaders;
  setHeader: (k: string, v: string) => void;
  setStatus: (s: number) => void;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const VERSION = "0.1.0";

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}$`,
  );
  return { method, pattern, keys, handler };
}

function str(body: Json, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v) throw new OictError("BAD_REQUEST", `${key} must be a non-empty string`);
  return v;
}

/** Create the OICT reference HTTP server. Call `.listen(port)` to start it. */
export function createServer(opts: ServerOptions = {}): http.Server {
  let clockOffset = 0;
  const makeEngine = () =>
    new OictEngine({ ...opts.engine, now: () => Date.now() + clockOffset, catalog: SYNTHETIC_CATALOG });
  let engine = makeEngine();

  const routes: Route[] = [
    route("GET", "/healthz", () => ({ status: "ok", spec: "OICT", version: VERSION })),
    route("GET", "/v1/catalog", ({ engine }) => ({ items: engine.listCatalog() })),

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

    route("POST", "/v1/grants", ({ engine, body, setStatus }) => {
      setStatus(201);
      return engine.issueGrant({
        issuer: str(body, "issuer"),
        subject: str(body, "subject"),
        application: str(body, "application"),
        scopes: body.scopes as never,
        ttlSeconds: Number(body.ttlSeconds ?? 3600),
        parentGrantId: body.parentGrantId as string | undefined,
        guardianConsentRef: body.guardianConsentRef as string | undefined,
        maxOrderTotalMinor: body.maxOrderTotalMinor as number | undefined,
      });
    }),

    route("POST", "/v1/grants/:id/revoke", ({ engine, params, body }) =>
      engine.revokeGrant(params.id!, str(body, "by")),
    ),

    route("POST", "/v1/sessions", ({ engine, body, setStatus }) => {
      setStatus(201);
      return engine.createSession(str(body, "consumerId"), str(body, "applicationId"));
    }),

    route("GET", "/v1/sessions/:id", ({ engine, params }) => {
      const session = engine.session(params.id!);
      if (!session.selection) return { session, snapshot: null, snapshotHash: null };
      const snapshot = engine.snapshot(session);
      return { session, snapshot, snapshotHash: digest(snapshot) };
    }),

    route("POST", "/v1/sessions/:id/selection", ({ engine, params, body }) => {
      const { session, snapshot, snapshotHash } = engine.updateSelection(params.id!, {
        sceneObjectId: str(body, "sceneObjectId"),
        sku: str(body, "sku"),
        variantId: str(body, "variantId"),
        quantity: Number(body.quantity ?? 1),
      });
      return { stateVersion: session.stateVersion, snapshot, snapshotHash };
    }),

    route("POST", "/v1/carts", ({ engine, body, grantId, setStatus }) => {
      setStatus(201);
      return engine.prepareCart(grantId, str(body, "sessionId"), Number(body.stateVersion));
    }),

    route("POST", "/v1/confirmations", ({ engine, body, setStatus }) => {
      setStatus(201);
      const { token, claims } = engine.confirm({
        sessionId: str(body, "sessionId"),
        consumerId: str(body, "consumerId"),
        snapshotHash: str(body, "snapshotHash"),
        guardianConsentRef: body.guardianConsentRef as string | undefined,
      });
      return { confirmationToken: token, expiresAt: claims.exp, totalMinor: claims.totalMinor, currency: claims.currency };
    }),

    route("POST", "/v1/orders", ({ engine, body, grantId, headers, setHeader, setStatus }) => {
      const key = headers["idempotency-key"];
      const { order, replayed } = engine.placeOrder({
        grantId: grantId ?? "",
        idempotencyKey: Array.isArray(key) ? key[0] : key,
        sessionId: str(body, "sessionId"),
        confirmationToken: str(body, "confirmationToken"),
      });
      setHeader("OICT-Idempotent-Replay", String(replayed));
      setStatus(replayed ? 200 : 201);
      return order;
    }),

    route("GET", "/v1/orders/:id", ({ engine, params, grantId }) => engine.getOrder(params.id!, grantId)),
  ];

  if (opts.testHooks) {
    routes.push(
      route("POST", "/v1/_test/reset", () => {
        clockOffset = 0;
        engine = makeEngine();
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

  return http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, idempotency-key",
        "access-control-expose-headers": "oict-idempotent-replay",
        "x-oict-version": VERSION,
      });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "OPTIONS") return send(204, {});

    const url = new URL(req.url ?? "/", "http://localhost");
    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null }))
      .find((x) => x.m);
    if (!match?.m) return send(404, { error: { code: "NOT_FOUND", message: `no route ${req.method} ${url.pathname}` } });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) return send(413, { error: { code: "BAD_REQUEST", message: "body too large" } });
    }
    let body: Json = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Json;
      } catch {
        return send(400, { error: { code: "BAD_REQUEST", message: "body must be a JSON object" } });
      }
    }

    const auth = req.headers.authorization ?? "";
    const grantId = /^OICT-Grant\s+(\S+)$/i.exec(auth)?.[1];
    const params: Record<string, string> = {};
    match.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match.m![i + 1]!)));

    let status = 200;
    const extraHeaders: Record<string, string> = {};
    try {
      const result = await match.r.handler({
        engine,
        params,
        body,
        grantId,
        headers: req.headers,
        setHeader: (k, v) => (extraHeaders[k] = v),
        setStatus: (s) => (status = s),
      });
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      send(status, result);
    } catch (err) {
      if (err instanceof OictError) return send(err.status, { error: { code: err.code, message: err.message } });
      console.error(err);
      send(500, { error: { code: "INTERNAL", message: "internal error" } });
    }
  });
}
