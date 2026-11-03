import { OictClient, OictError, apiBaseFromLocation, demoWorld, money, newKey } from "../shared/oict-client.js";

const $ = (id) => document.getElementById(id);
const api = new OictClient(apiBaseFromLocation());
$("api-url").textContent = api.base;

const state = { world: null, catalog: new Map(), lines: [], view: null, busy: false };

// ───────────────────────────── language ─────────────────────────────
// Nova is deliberately rule-based: the point is what the transaction layer
// allows an assistant to do, not the language model behind it.
const PRODUCTS = [
  { sku: "SYN-HOODIE-01", words: ["hoodie", "hoodies", "sweatshirt"] },
  { sku: "SYN-SNEAKER-07", words: ["sneaker", "sneakers", "shoe", "shoes", "runner", "runners"] },
  { sku: "SYN-LAMP-03", words: ["lamp", "lamps", "light"] },
  { sku: "SYN-POSTER-EU", words: ["poster", "print", "aurora"] },
];
const VARIANT_WORDS = [
  ["violet-l", ["large", " l "]], ["violet-m", ["violet", "purple"]], ["teal-m", ["teal", "green"]],
  ["black-10", ["black", "10"]], ["white-9", ["white", "9"]],
];
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function findProduct(text) {
  return PRODUCTS.find((p) => p.words.some((w) => new RegExp(`\\b${w}\\b`).test(text)))?.sku;
}
function findVariant(sku, text) {
  const item = state.catalog.get(sku);
  const padded = ` ${text} `;
  for (const [variantId, words] of VARIANT_WORDS) {
    if (item.variants.some((v) => v.variantId === variantId) && words.some((w) => padded.includes(w))) return variantId;
  }
  return item.variants[0].variantId;
}
function findQuantity(text) {
  const n = /\b(\d{1,2})\b/.exec(text.replace(/\b(9|10)\b(?=\s*(shoe|sneaker|runner|size))/g, ""));
  if (n) return Number(n[1]);
  for (const [w, v] of Object.entries(NUMBERS)) if (new RegExp(`\\b${w}\\b`).test(text)) return v;
  return 1;
}

function parse(raw) {
  const t = raw.toLowerCase().trim();
  if (/\b(buy|checkout|check out|place (the )?order|pay)\b/.test(t)) return { intent: "buy" };
  if (/\b(what('?s| is) in|show) (my )?cart\b|\bmy cart\b/.test(t)) return { intent: "cart" };
  if (/\b(remove|delete|drop)\b/.test(t)) return { intent: "remove", sku: findProduct(t) };
  if (/\b(tell me about|describe|what about|details)\b/.test(t)) return { intent: "about", sku: findProduct(t) };
  if (/\b(make it|change|set)\b/.test(t)) return { intent: "set", sku: findProduct(t), quantity: findQuantity(t) };
  if (/\b(add|get|want|i'?ll take|put)\b/.test(t)) {
    const sku = findProduct(t);
    return { intent: "add", sku, variantId: sku && findVariant(sku, t), quantity: findQuantity(t) };
  }
  if (/\b(what do you have|catalog|show|options|products)\b/.test(t)) return { intent: "catalog" };
  return { intent: "help" };
}

// ───────────────────────────── chat UI ─────────────────────────────
function bubble(who, html, cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${who} ${cls}`;
  div.innerHTML = who === "bot" ? `<span class="who">Nova</span>${html}` : html;
  $("messages").append(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function log(kind, html, code) {
  const li = document.createElement("li");
  li.className = kind;
  li.innerHTML = `${html}${code ? `<span class="code">${code}</span>` : ""}`;
  $("log").prepend(li);
}

const title = (sku) => state.catalog.get(sku)?.title ?? sku;
const label = (sku, variantId) => state.catalog.get(sku)?.variants.find((v) => v.variantId === variantId)?.label ?? variantId;

function renderCart() {
  const snap = state.view?.snapshot;
  const lines = snap?.lines ?? [];
  $("cart-empty").hidden = lines.length > 0;
  $("cart-foot").hidden = lines.length === 0;
  $("lines").replaceChildren(
    ...lines.map((l) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${title(l.sku)} <span class="muted">· ${label(l.sku, l.variantId)} × ${l.quantity}</span></span><span class="mono">${money(l.lineTotalMinor, snap.currency)}</span>`;
      return li;
    }),
  );
  if (snap) $("cart-total").textContent = money(snap.totalMinor, snap.currency);
  const v = state.view?.stateVersion;
  $("cart-state").textContent = v === undefined ? "" : `stateVersion ${v}${state.view.snapshotHash ? ` · ${state.view.snapshotHash.slice(0, 22)}…` : " · empty"}`;
  $("state-pill").textContent = v === undefined ? "state —" : `state v${v}`;
}

async function refreshAudit() {
  if (!$("audit-box").open || !state.world) return;
  const events = await api.audit(state.world.appGrant.accessToken, 30).catch(() => []);
  $("audit").replaceChildren(
    ...events.map((e) => {
      const li = document.createElement("li");
      li.className = e.type === "order.refused" ? "stop" : e.type === "order.placed" ? "ok" : "info";
      li.innerHTML = `<b>${e.type}</b> by ${e.actor ?? "?"}${e.code ? `<span class="code">${e.code}</span>` : ""}`;
      return li;
    }),
  );
}
$("audit-box").addEventListener("toggle", refreshAudit);

// ───────────────────────────── what Nova can do ─────────────────────────────
async function applyCart(lines) {
  state.view = lines.length ? await api.setCart(state.world.session.id, lines) : await api.clearCart(state.world.session.id);
  state.lines = lines;
  renderCart();
  if (!lines.length) return null;
  // AGT-2/AGT-3: Nova drafts the cart with its own token, bound to the state version it just saw.
  const draft = await api.draftCart(state.world.agentGrant.accessToken, state.world.session.id, state.view.stateVersion);
  log("info", `Nova drafted the cart at state v${draft.stateVersion} with its own token (cart:write only).`, "201 · draft cart");
  return draft;
}

const SKILLS = {
  async catalog() {
    const items = [...state.catalog.values()];
    return `Here is what this store has:<ul>${items
      .map((i) => `<li><b>${i.title}</b>: ${i.variants.map((v) => `${v.label} ${money(v.unitPriceMinor, i.currency)}`).join(", ")}</li>`)
      .join("")}</ul>`;
  },

  async add({ sku, variantId, quantity }) {
    if (!sku) return "Which product? I know hoodies, sneakers, desk lamps and one EU poster.";
    const existing = state.lines.find((l) => l.sku === sku && l.variantId === variantId);
    const lines = existing
      ? state.lines.map((l) => (l === existing ? { ...l, quantity: Math.min(99, l.quantity + quantity) } : l))
      : [...state.lines, { sceneObjectId: `chat-${sku}`, sku, variantId, quantity }];
    try {
      await applyCart(lines);
      return `Added ${quantity} × ${title(sku)} (${label(sku, variantId)}). The cart on the right is what you would confirm.<br><span class="tag">state v${state.view.stateVersion}</span>`;
    } catch (e) {
      log("stop", "Cart refused.", e.code);
      return `The store refused that: ${esc(e.message)}.<br><span class="tag stop">${e.code}</span>`;
    }
  },

  async set({ sku, quantity }) {
    const line = state.lines.find((l) => l.sku === sku) ?? (state.lines.length === 1 ? state.lines[0] : undefined);
    if (!line) return "Which item should I change?";
    await applyCart(state.lines.map((l) => (l === line ? { ...l, quantity } : l)));
    return `Done: ${title(line.sku)} × ${quantity}.<br><span class="tag">state v${state.view.stateVersion}</span>`;
  },

  async remove({ sku }) {
    const line = state.lines.find((l) => l.sku === sku);
    if (!line) return "That is not in your cart.";
    await applyCart(state.lines.filter((l) => l !== line));
    return `Removed ${title(line.sku)}.`;
  },

  async cart() {
    const snap = state.view?.snapshot;
    if (!snap) return "Your cart is empty.";
    return `You have ${snap.lines.map((l) => `${l.quantity} × ${title(l.sku)}`).join(" and ")}, ${money(snap.totalMinor, snap.currency)} in total.`;
  },

  /**
   * AGT-4: a slow answer is bound to the cart version it was asked about. If
   * the cart changes before it arrives, it is shown as outdated, never as a
   * description of what is on screen now.
   */
  async about({ sku }, askedAtVersion) {
    if (!sku) return "Which product would you like to hear about?";
    const item = state.catalog.get(sku);
    await new Promise((r) => setTimeout(r, 1400)); // a slow model call
    const text = `${item.title} comes in ${item.variants.map((v) => v.label).join(", ")}, from ${money(Math.min(...item.variants.map((v) => v.unitPriceMinor)), item.currency)}.`;
    const nowVersion = state.view?.stateVersion;
    if (nowVersion !== askedAtVersion) {
      return { stale: true, html: `${text}<br><span class="tag warn">answered for state v${askedAtVersion ?? 0}; your cart is now v${nowVersion}, so this is not about what you see now</span>` };
    }
    return `${text}<br><span class="tag">bound to state v${askedAtVersion ?? 0}</span>`;
  },

  async buy() {
    if (!state.view?.snapshotHash) return "There is nothing to buy yet.";
    // Nova really tries, with its own token. The transaction layer refuses (AGT-1).
    try {
      const c = await api.confirm(state.world.session.id, state.world.consumerId, state.view.snapshotHash);
      await api.placeOrder(state.world.agentGrant.accessToken, state.world.session.id, c.confirmationToken, newKey("nova"));
      return "That should not have worked.";
    } catch (e) {
      log("stop", "Nova tried to place the order with its own token: refused.", e.code);
      return `I tried, and the store refused: my access only lets me prepare carts.<br><span class="tag stop">${e.code}</span><br>Please check the cart on the right and tap <b>Confirm and buy</b> yourself.`;
    }
  },

  async help() {
    return "I can show products, add or remove items, change quantities and tell you about a product. I can prepare your cart, but I cannot buy for you.";
  },
};

async function handle(text) {
  bubble("user", esc(text));
  const cmd = parse(text);
  const askedAt = state.view?.stateVersion;
  const typing = bubble("bot", `<span class="typing">thinking…</span>`);
  try {
    const out = await SKILLS[cmd.intent](cmd, askedAt);
    const html = typeof out === "string" ? out : out.html;
    typing.innerHTML = `<span class="who">Nova</span>${html}`;
    if (typeof out === "object" && out.stale) typing.classList.add("stale");
  } catch (e) {
    typing.innerHTML = `<span class="who">Nova</span>Something went wrong.<br><span class="tag stop">${e.code ?? e.message}</span>`;
  }
  refreshAudit();
}

// ───────────────────────────── the person decides ─────────────────────────────
$("confirm").onclick = async () => {
  const shown = state.view;
  try {
    const c = await api.confirm(state.world.session.id, state.world.consumerId, shown.snapshotHash);
    const r = await api.placeOrder(state.world.appGrant.accessToken, state.world.session.id, c.confirmationToken, newKey());
    log("ok", `You confirmed and the app placed order <b>${r.data.id}</b> for ${money(r.data.totalMinor, r.data.currency)}.`, "201 · order created");
    bubble("bot", `Order <b>${r.data.id}</b> is placed: ${money(r.data.totalMinor, r.data.currency)}, exactly the cart you confirmed.<br><span class="tag ok">placed by ${state.world.appId} for you</span>`);
    await applyCart([]);
  } catch (e) {
    log("stop", "Order refused.", e.code);
    bubble("bot", `The store refused the order.<br><span class="tag stop">${e.code}</span>`);
  }
  refreshAudit();
};

const SUGGESTIONS = ["What do you have?", "Add 2 teal hoodies", "Tell me about the lamp", "Add a desk lamp", "Make it 3 lamps", "Add the poster", "Buy it for me"];
$("suggestions").replaceChildren(
  ...SUGGESTIONS.map((s) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = s;
    b.onclick = () => handle(s);
    return b;
  }),
);
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("input").value.trim();
  if (!v) return;
  $("input").value = "";
  handle(v);
});

async function boot() {
  try {
    const h = await api.health();
    $("server-pill").className = "pill ok";
    $("server-pill").innerHTML = `<i></i>${h.instance} · ${h.store} · v${h.version}`;
  } catch {
    $("server-pill").className = "pill bad";
    $("server-pill").innerHTML = "<i></i>server offline";
    $("offline").hidden = false;
    return;
  }
  for (const item of await api.catalog()) state.catalog.set(item.sku, item);
  state.world = await demoWorld(api, { appId: "space-mall-chat" });
  renderCart();
  bubble("bot", `Hi, I'm Nova. I can find things and fill your cart. I hold a token that only lets me <b>prepare</b> carts, so you always make the final call.<br><span class="tag">agent grant: cart:write</span>`);
  log("info", `Signed in as <b>${state.world.consumerId}</b>. Nova acts under a grant delegated by ${state.world.appId}.`);
}
boot().catch((e) => bubble("bot", `Startup failed.<br><span class="tag stop">${e.code ?? e.message}</span>`));
