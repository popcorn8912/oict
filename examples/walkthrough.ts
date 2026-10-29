#!/usr/bin/env node
/**
 * A narrated end-to-end walkthrough against an in-process reference server:
 * a shopper in a 3D scene, an AI helper, a price change, a retry storm.
 *
 *   node examples/walkthrough.ts
 */
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server/http.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const p = (c: string) => (s: string) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = p("90"), green = p("32"), red = p("31"), cyan = p("36"), yellow = p("33"), bold = p("1"), magenta = p("35");

const server = createServer({ testHooks: true });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any, replay: res.headers.get("oict-idempotent-replay") };
}
const step = (n: number, s: string) => console.log(`\n${magenta(`  ${n}.`)} ${bold(s)}`);
const ok = (s: string) => console.log(`     ${green("✔")} ${s}`);
const blocked = (s: string) => console.log(`     ${red("⛔")} ${s}`);
const note = (s: string) => console.log(`     ${dim(s)}`);

console.log(`\n  ${magenta("◆")} ${bold("OICT walkthrough")} ${dim("— synthetic data, in-process server")}`);

step(1, "Register the parties");
for (const p of [
  { id: "spatial-co", kind: "platform" },
  { id: "pixel-studio", kind: "developer" },
  { id: "space-mall", kind: "application", platformId: "spatial-co", developerId: "pixel-studio" },
  { id: "maya", kind: "consumer", ageBand: "adult" },
  { id: "shop-helper", kind: "agent" },
]) await call("POST", "/v1/participants", p);
ok(`platform ${cyan("spatial-co")} → developer ${cyan("pixel-studio")} → app ${cyan("space-mall")}`);

step(2, "Maya authorizes the app, and the app delegates a slice to its AI helper");
const appGrant = (await call("POST", "/v1/grants", { issuer: "maya", subject: "space-mall", application: "space-mall", scopes: ["catalog:read", "cart:write", "order:place", "order:read"], ttlSeconds: 3600 })).body;
ok(`grant ${dim(appGrant.id)}  scopes: ${appGrant.scopes.join(" ")}`);
const agentTry = await call("POST", "/v1/grants", { issuer: "space-mall", subject: "shop-helper", application: "space-mall", scopes: ["cart:write", "order:place"], ttlSeconds: 600, parentGrantId: appGrant.id });
blocked(`helper asked for order:place → ${yellow(agentTry.body.error.code)}`);
const agentGrant = (await call("POST", "/v1/grants", { issuer: "space-mall", subject: "shop-helper", application: "space-mall", scopes: ["cart:write"], ttlSeconds: 600, parentGrantId: appGrant.id })).body;
ok(`helper gets cart:write only ${dim(agentGrant.id)}`);

step(3, "Maya picks up a hoodie in the 3D scene");
const session = (await call("POST", "/v1/sessions", { consumerId: "maya", applicationId: "space-mall" })).body;
let sel = (await call("POST", `/v1/sessions/${session.id}/selection`, { sceneObjectId: "rack-03", sku: "SYN-HOODIE-01", variantId: "violet-m", quantity: 1 })).body;
ok(`stateVersion ${sel.stateVersion}  ${sel.snapshot.variantId}  $${(sel.snapshot.unitPriceMinor / 100).toFixed(2)}  ${dim(sel.snapshotHash.slice(0, 22) + "…")}`);
const staleAgentVersion = sel.stateVersion;
sel = (await call("POST", `/v1/sessions/${session.id}/selection`, { sceneObjectId: "rack-03", sku: "SYN-HOODIE-01", variantId: "teal-m", quantity: 1 })).body;
ok(`switches to ${sel.snapshot.variantId} → stateVersion ${sel.stateVersion}  $${(sel.snapshot.unitPriceMinor / 100).toFixed(2)}`);

step(4, "The AI helper, a beat behind, drafts a cart for the old variant");
const late = await call("POST", "/v1/carts", { sessionId: session.id, stateVersion: staleAgentVersion }, { authorization: `OICT-Grant ${agentGrant.id}` });
blocked(`draft against stateVersion ${staleAgentVersion} → ${yellow(late.body.error.code)}`);
const cart = (await call("POST", "/v1/carts", { sessionId: session.id, stateVersion: sel.stateVersion }, { authorization: `OICT-Grant ${agentGrant.id}` })).body;
ok(`draft cart for current state ${dim(cart.id)} ${dim("(drafts never become orders on their own)")}`);

step(5, "Maya taps Buy — then the price changes before the order lands");
let conf = (await call("POST", "/v1/confirmations", { sessionId: session.id, consumerId: "maya", snapshotHash: sel.snapshotHash })).body;
ok(`confirmation bound to ${dim(sel.snapshotHash.slice(0, 22) + "…")}, expires in 120 s`);
await call("POST", "/v1/_test/price", { sku: "SYN-HOODIE-01", variantId: "teal-m", unitPriceMinor: 4500 });
note("merchant updates teal-m: $39.00 → $45.00");
const auth = { authorization: `OICT-Grant ${appGrant.id}` };
let r = await call("POST", "/v1/orders", { sessionId: session.id, confirmationToken: conf.confirmationToken }, { ...auth, "idempotency-key": "maya-order-attempt-1" });
blocked(`order → ${yellow(r.body.error.code)} ${dim("— Maya never agreed to $45")}`);

step(6, "Maya sees the new price and confirms again");
sel = (await call("GET", `/v1/sessions/${session.id}`)).body;
note(`UI re-renders the current snapshot: $${(sel.snapshot.unitPriceMinor / 100).toFixed(2)}`);
conf = (await call("POST", "/v1/confirmations", { sessionId: session.id, consumerId: "maya", snapshotHash: sel.snapshotHash })).body;
r = await call("POST", "/v1/orders", { sessionId: session.id, confirmationToken: conf.confirmationToken }, { ...auth, "idempotency-key": "maya-order-attempt-2" });
ok(`order ${cyan(r.body.id)}  $${(r.body.totalMinor / 100).toFixed(2)}  ${dim(`HTTP ${r.status}`)}`);

step(7, "The headset's Wi-Fi drops; the client retries — twice");
const replay = await call("POST", "/v1/orders", { sessionId: session.id, confirmationToken: conf.confirmationToken }, { ...auth, "idempotency-key": "maya-order-attempt-2" });
ok(`same key → same order ${cyan(replay.body.id)} ${dim(`(replay: ${replay.replay})`)}`);
const regen = await call("POST", "/v1/orders", { sessionId: session.id, confirmationToken: conf.confirmationToken }, { ...auth, "idempotency-key": "regenerated-after-timeout" });
blocked(`regenerated key → ${yellow(regen.body.error.code)} ${dim("— one tap, one order")}`);

console.log(`\n  ${green("✔")} ${bold("1 intended order. 0 unintended orders.")}\n`);
server.close();
