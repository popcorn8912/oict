// OICT browser client — a thin, dependency-free wrapper around the reference API.
// Used by the sample clients; small enough to copy into any web or WebView app.

export class OictError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export class OictClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  async request(method, path, { body, token, headers = {} } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new OictError(res.status, data?.error?.code ?? "HTTP_" + res.status, data?.error?.message);
    return { data, replayed: res.headers.get("oict-idempotent-replay") === "true" };
  }

  health() {
    return this.request("GET", "/healthz").then((r) => r.data);
  }
  catalog() {
    return this.request("GET", "/v1/catalog").then((r) => r.data.items);
  }
  register(participant) {
    return this.request("POST", "/v1/participants", { body: participant }).then((r) => r.data);
  }
  grant(body) {
    return this.request("POST", "/v1/grants", { body }).then((r) => r.data);
  }
  revoke(grantId, by, scopes) {
    return this.request("POST", `/v1/grants/${grantId}/revoke`, { body: scopes ? { by, scopes } : { by } }).then((r) => r.data);
  }
  openSession(consumerId, applicationId) {
    return this.request("POST", "/v1/sessions", { body: { consumerId, applicationId } }).then((r) => r.data);
  }
  view(sessionId) {
    return this.request("GET", `/v1/sessions/${sessionId}`).then((r) => r.data);
  }
  /** Replace the whole cart. Returns { stateVersion, snapshot, snapshotHash }. */
  setCart(sessionId, lines) {
    return this.request("PUT", `/v1/sessions/${sessionId}/cart`, { body: { lines } }).then((r) => r.data);
  }
  clearCart(sessionId) {
    return this.request("DELETE", `/v1/sessions/${sessionId}/cart`).then((r) => r.data);
  }
  /** An agent drafts a cart at the state version it saw (needs cart:write). */
  draftCart(token, sessionId, stateVersion) {
    return this.request("POST", "/v1/carts", { token, body: { sessionId, stateVersion } }).then((r) => r.data);
  }
  /** The consumer confirms exactly the snapshot their screen shows. */
  confirm(sessionId, consumerId, snapshotHash, guardianConsentRef) {
    return this.request("POST", "/v1/confirmations", { body: { sessionId, consumerId, snapshotHash, guardianConsentRef } }).then((r) => r.data);
  }
  /** Place the order. Reuse the same idempotency key when retrying. */
  placeOrder(token, sessionId, confirmationToken, idempotencyKey) {
    return this.request("POST", "/v1/orders", {
      token,
      body: { sessionId, confirmationToken },
      headers: { "idempotency-key": idempotencyKey },
    });
  }
  audit(token, limit = 50) {
    return this.request("GET", `/v1/audit?limit=${limit}`, { token }).then((r) => r.data.events);
  }
  /** Demo hook (server started with OICT_TEST_HOOKS=1): the merchant changes a price. */
  merchantSetPrice(sku, variantId, unitPriceMinor) {
    return this.request("POST", "/v1/_test/price", { body: { sku, variantId, unitPriceMinor } }).then((r) => r.data);
  }
}

export const newKey = (prefix = "order") => `${prefix}-${crypto.randomUUID()}`;
export const money = (minor, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

/**
 * Sets up a fresh demo world on the reference server: one platform, developer
 * and application, a shopper with a full grant to the app, and an AI helper
 * whose delegated grant is limited to drafting carts.
 */
export async function demoWorld(api, { appId = "space-mall", shopperName = "Maya" } = {}) {
  const suffix = Math.random().toString(36).slice(2, 7);
  const consumerId = `${shopperName.toLowerCase()}-${suffix}`;
  await api.register({ id: "spatial-co", kind: "platform" });
  await api.register({ id: "pixel-studio", kind: "developer" });
  await api.register({ id: appId, kind: "application", platformId: "spatial-co", developerId: "pixel-studio" });
  await api.register({ id: consumerId, kind: "consumer", ageBand: "adult", displayName: shopperName });
  await api.register({ id: `helper-${suffix}`, kind: "agent", displayName: "Nova" });
  const appGrant = await api.grant({
    issuer: consumerId, subject: appId, application: appId,
    scopes: ["catalog:read", "cart:write", "order:place", "order:read"], ttlSeconds: 3600,
  });
  const agentGrant = await api.grant({
    issuer: appId, subject: `helper-${suffix}`, application: appId,
    scopes: ["cart:write"], ttlSeconds: 1800, parentGrantId: appGrant.id,
  });
  const session = await api.openSession(consumerId, appId);
  return { consumerId, appId, agentId: `helper-${suffix}`, appGrant, agentGrant, session };
}

export function apiBaseFromLocation(defaultBase = "http://localhost:8787") {
  const q = new URLSearchParams(location.search).get("api");
  return q || defaultBase;
}
