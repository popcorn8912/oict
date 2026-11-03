import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OictClient, OictError, apiBaseFromLocation, demoWorld, money, newKey } from "../shared/oict-client.js";

const $ = (id) => document.getElementById(id);
const api = new OictClient(apiBaseFromLocation());
$("api-url").textContent = api.base;

// ───────────────────────────── app state ─────────────────────────────
const state = {
  world: null,
  catalog: new Map(), // sku -> item
  selected: null, // { sku, variantId }
  qty: 1,
  lines: [], // [{ sceneObjectId, sku, variantId, quantity }]
  view: null, // { stateVersion, snapshot, snapshotHash }
  confirmation: null, // { token, snapshotHash }
  lastOrder: null, // { token, key }
};

const VARIANT_COLOR = {
  "violet-m": 0xb490ff, "violet-l": 0x9c7bff, "teal-m": 0x5ee7df,
  "white-9": 0xece9ff, "black-10": 0x4a4560, std: 0xf7c873, a2: 0xff8bd1,
};

// ───────────────────────────── log & audit ─────────────────────────────
const WHY = {
  STALE_CONFIRMATION: "The cart changed after you confirmed. Review it and confirm again.",
  CONFIRMATION_CONSUMED: "That confirmation already bought something. A retry with a new request id cannot buy twice.",
  CONFIRMATION_EXPIRED: "Confirmations last two minutes. Confirm again.",
  SCOPE_INSUFFICIENT: "This app no longer has the right to place orders for you.",
  BAD_REQUEST: "The server refused this cart.",
};
function log(kind, html, code, why) {
  const li = document.createElement("li");
  li.className = kind;
  li.innerHTML = `${html}${code ? `<span class="code">${code}</span>` : ""}${why ? `<span class="muted">${why}</span>` : ""}`;
  $("log").prepend(li);
}
async function refreshAudit() {
  if (!$("audit-box").open || !state.world) return;
  try {
    const events = await api.audit(state.world.appGrant.accessToken, 30);
    $("audit").replaceChildren(
      ...events.map((e) => {
        const li = document.createElement("li");
        li.className = e.type === "order.refused" ? "stop" : e.type === "order.placed" ? "ok" : "info";
        li.innerHTML = `<b>${e.type}</b> by ${e.actor ?? "?"}${e.code ? `<span class="code">${e.code}</span>` : ""}`;
        return li;
      }),
    );
  } catch (e) {
    $("audit").innerHTML = `<li class="stop">Audit trail unavailable<span class="code">${e.code ?? e.message}</span></li>`;
  }
}
$("audit-box").addEventListener("toggle", refreshAudit);

// ───────────────────────────── panels ─────────────────────────────
function variantOf(sku, variantId) {
  return state.catalog.get(sku)?.variants.find((v) => v.variantId === variantId);
}

function renderSelected() {
  const sel = state.selected;
  $("selected").hidden = !sel;
  $("selected-empty").hidden = !!sel;
  if (!sel) return;
  const item = state.catalog.get(sel.sku);
  const variant = variantOf(sel.sku, sel.variantId);
  $("sel-title").textContent = item.title;
  $("sel-price").textContent = `${money(variant.unitPriceMinor, item.currency)} · ${variant.label}`;
  $("qty").textContent = String(state.qty);
  $("sel-variants").replaceChildren(
    ...item.variants.map((v) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.textContent = v.label;
      b.setAttribute("aria-pressed", String(v.variantId === sel.variantId));
      b.onclick = () => {
        state.selected = { sku: sel.sku, variantId: v.variantId };
        recolor(sel.sku, v.variantId);
        renderSelected();
      };
      return b;
    }),
  );
}

function renderCart() {
  const snap = state.view?.snapshot;
  const lines = snap?.lines ?? [];
  $("cart-empty").hidden = lines.length > 0;
  $("cart-foot").hidden = lines.length === 0;
  $("lines").replaceChildren(
    ...lines.map((l) => {
      const item = state.catalog.get(l.sku);
      const li = document.createElement("li");
      li.innerHTML = `<span>${item?.title ?? l.sku} <span class="muted">· ${variantOf(l.sku, l.variantId)?.label ?? l.variantId}</span></span>`;
      const stepper = document.createElement("span");
      stepper.className = "stepper";
      const minus = Object.assign(document.createElement("button"), { type: "button", textContent: "−", ariaLabel: "Fewer" });
      const plus = Object.assign(document.createElement("button"), { type: "button", textContent: "+", ariaLabel: "More" });
      const n = Object.assign(document.createElement("span"), { textContent: String(l.quantity) });
      minus.onclick = () => changeQty(l.sku, l.variantId, l.quantity - 1);
      plus.onclick = () => changeQty(l.sku, l.variantId, l.quantity + 1);
      stepper.append(minus, n, plus);
      const x = Object.assign(document.createElement("button"), { type: "button", className: "x", textContent: "×", ariaLabel: "Remove" });
      x.onclick = () => changeQty(l.sku, l.variantId, 0);
      li.append(stepper, x);
      return li;
    }),
  );
  if (snap) {
    $("cart-total").textContent = money(snap.totalMinor, snap.currency);
    $("cart-hash").textContent = `stateVersion ${snap.stateVersion} · ${state.view.snapshotHash.slice(0, 22)}…`;
    $("state-pill").textContent = `state v${snap.stateVersion} · ${state.view.snapshotHash.slice(7, 15)}`;
  } else {
    $("cart-hash").textContent = state.view ? `stateVersion ${state.view.stateVersion} · empty` : "";
    if (state.view) $("state-pill").textContent = `state v${state.view.stateVersion} · empty`;
  }
}

function renderSheet() {
  const c = state.confirmation;
  $("sheet").hidden = !c;
  if (!c) return;
  const snap = c.snapshot;
  $("sheet-lines").replaceChildren(
    ...snap.lines.map((l) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${state.catalog.get(l.sku)?.title ?? l.sku} × ${l.quantity}</span><span class="mono">${money(l.lineTotalMinor, snap.currency)}</span><span></span>`;
      return li;
    }),
  );
  $("sheet-total").textContent = money(snap.totalMinor, snap.currency);
  $("sheet-note").textContent = `Signed confirmation of ${c.snapshotHash.slice(0, 22)}… · valid 2 minutes`;
}

// ───────────────────────────── cart actions ─────────────────────────────
async function pushCart(lines, why) {
  try {
    state.view = lines.length ? await api.setCart(state.world.session.id, lines) : await api.clearCart(state.world.session.id);
    state.lines = lines;
    if (state.confirmation) {
      log("info", "The cart changed while a confirmation was open, so the open confirmation no longer matches.");
    }
    if (why) log("info", why);
  } catch (e) {
    log("stop", "Cart refused.", e.code, e.message);
  }
  renderCart();
}

function changeQty(sku, variantId, quantity) {
  const lines = state.lines
    .map((l) => (l.sku === sku && l.variantId === variantId ? { ...l, quantity } : l))
    .filter((l) => l.quantity > 0);
  pushCart(lines, quantity === 0 ? `Removed ${state.catalog.get(sku).title}.` : `${state.catalog.get(sku).title} × ${quantity}.`);
}

$("qty-minus").onclick = () => {
  state.qty = Math.max(1, state.qty - 1);
  renderSelected();
};
$("qty-plus").onclick = () => {
  state.qty = Math.min(99, state.qty + 1);
  renderSelected();
};
$("add").onclick = () => {
  const { sku, variantId } = state.selected;
  const existing = state.lines.find((l) => l.sku === sku && l.variantId === variantId);
  const lines = existing
    ? state.lines.map((l) => (l === existing ? { ...l, quantity: Math.min(99, l.quantity + state.qty) } : l))
    : [...state.lines, { sceneObjectId: `pedestal-${sku}`, sku, variantId, quantity: state.qty }];
  pushCart(lines, `Added ${state.catalog.get(sku).title} (${variantOf(sku, variantId).label}) × ${state.qty}.`);
};

$("review").onclick = async () => {
  try {
    // Confirm exactly what is on screen: the snapshot hash this page rendered.
    const c = await api.confirm(state.world.session.id, state.world.consumerId, state.view.snapshotHash);
    state.confirmation = { token: c.confirmationToken, snapshotHash: state.view.snapshotHash, snapshot: state.view.snapshot };
    renderSheet();
  } catch (e) {
    log("stop", "Could not confirm.", e.code, WHY[e.code] ?? e.message);
    await reload();
  }
};
$("cancel").onclick = () => {
  state.confirmation = null;
  renderSheet();
};

async function attemptOrder(token, key, label) {
  try {
    const r = await api.placeOrder(state.world.appGrant.accessToken, state.world.session.id, token, key);
    if (r.replayed) log("ok", `${label}: same request id, so the server returned the existing order <b>${r.data.id}</b>.`, "replayed · no new order");
    else log("ok", `${label}: order <b>${r.data.id}</b> for ${money(r.data.totalMinor, r.data.currency)}.`, "201 · order created");
    return r;
  } catch (e) {
    log("stop", `${label}: refused.`, e.code, WHY[e.code] ?? e.message);
    throw e;
  }
}

$("place").onclick = async () => {
  const c = state.confirmation;
  const key = newKey();
  try {
    await attemptOrder(c.token, key, "Order");
    state.lastOrder = { token: c.token, key };
    $("retry").disabled = false;
    state.confirmation = null;
    await pushCart([], null);
  } catch (e) {
    if (e instanceof OictError && e.code === "STALE_CONFIRMATION") {
      state.confirmation = null;
      await reload();
    }
  }
  renderSheet();
  refreshAudit();
};

$("retry").onclick = async () => {
  const { token, key } = state.lastOrder;
  await attemptOrder(token, key, "Retry with the same request id").catch(() => {});
  await attemptOrder(token, newKey("regenerated"), "Retry with a regenerated request id").catch(() => {});
  refreshAudit();
};

$("reprice").onclick = async () => {
  const line = state.view?.snapshot?.lines?.[0];
  if (!line) return log("info", "Add something to the cart first.");
  const next = line.unitPriceMinor + 300;
  await api.merchantSetPrice(line.sku, line.variantId, next);
  const item = state.catalog.get(line.sku);
  log("info", `The merchant changed ${item.title} (${variantOf(line.sku, line.variantId).label}) to <b>${money(next, item.currency)}</b>.`);
  await reloadCatalog();
  updateLabel(line.sku, line.variantId);
  if (state.selected) renderSelected();
};

$("withdraw").onclick = async () => {
  const g = await api.revoke(state.world.appGrant.id, state.world.consumerId, ["order:place", "cart:write"]);
  log("info", `You withdrew purchase rights. ${state.world.appId} keeps <b>${g.scopes.join(" ")}</b>.`);
  $("withdraw").disabled = true;
};

async function reload() {
  state.view = await api.view(state.world.session.id);
  state.lines = state.view.snapshot ? state.view.snapshot.lines.map(({ sceneObjectId, sku, variantId, quantity }) => ({ sceneObjectId, sku, variantId, quantity })) : [];
  renderCart();
}
async function reloadCatalog() {
  for (const item of await api.catalog()) state.catalog.set(item.sku, item);
}

// ───────────────────────────── 3D showroom ─────────────────────────────
const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x16122e);
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x16122e, 14, 30);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 4.6, 12.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.1, 0);
controls.enableDamping = true;
controls.minPolarAngle = 0.6;
controls.maxPolarAngle = 1.45;
controls.minDistance = 6;
controls.maxDistance = 16;
controls.enablePan = false;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.35;

scene.add(new THREE.HemisphereLight(0xb490ff, 0x16122e, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(4, 8, 6);
scene.add(key);
const rim = new THREE.PointLight(0x5ee7df, 30, 20);
rim.position.set(-5, 3, -3);
scene.add(rim);

const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({ color: 0x1f1a48, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.PolarGridHelper(11, 16, 10, 64, 0x3a3277, 0x2a2458);
grid.position.y = 0.01;
scene.add(grid);

const SHAPES = {
  "SYN-HOODIE-01": () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.2, 0.55, 2, 2, 2), mat());
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.38, 24, 16), mat());
    hood.position.set(0, 0.72, -0.05);
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.7, 6, 12), mat());
    armL.position.set(-0.72, 0.05, 0);
    armL.rotation.z = 0.25;
    const armR = armL.clone();
    armR.position.x = 0.72;
    armR.rotation.z = -0.25;
    g.add(body, hood, armL, armR);
    return g;
  },
  "SYN-SNEAKER-07": () => {
    const g = new THREE.Group();
    const sole = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.18, 0.55), new THREE.MeshStandardMaterial({ color: 0xece9ff, roughness: 0.5 }));
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.8, 8, 16), mat());
    upper.rotation.z = Math.PI / 2;
    upper.position.y = 0.3;
    g.add(sole, upper);
    g.rotation.y = -0.5;
    return g;
  },
  "SYN-LAMP-03": () => {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 0.12, 32), new THREE.MeshStandardMaterial({ color: 0x2a2458, metalness: 0.6, roughness: 0.3 }));
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 12), new THREE.MeshStandardMaterial({ color: 0x8f89bd, metalness: 0.8, roughness: 0.2 }));
    arm.position.y = 0.6;
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 32, 1, true), mat({ side: THREE.DoubleSide }));
    shade.position.y = 1.25;
    const bulb = new THREE.PointLight(0xf7c873, 6, 4);
    bulb.position.y = 1.1;
    g.add(base, arm, shade, bulb);
    return g;
  },
  "SYN-POSTER-EU": () => {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.3, 0.06), new THREE.MeshStandardMaterial({ color: 0x2a2458 }));
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.12), mat());
    art.position.z = 0.035;
    g.add(frame, art);
    g.rotation.x = -0.12;
    return g;
  },
};
function mat(extra = {}) {
  return new THREE.MeshStandardMaterial({ color: 0xb490ff, roughness: 0.45, metalness: 0.1, emissive: 0x000000, ...extra });
}

const products = new Map(); // sku -> { group, pedestal, ring, label, baseY }
// Height above the floor at which each product sits on its pedestal (pedestal top is y = 0.6).
const REST_Y = { "SYN-HOODIE-01": 1.42, "SYN-SNEAKER-07": 0.82, "SYN-LAMP-03": 0.68, "SYN-POSTER-EU": 1.38 };
const LABEL_Y = { "SYN-HOODIE-01": 1.25, "SYN-SNEAKER-07": 0.75, "SYN-LAMP-03": 1.75, "SYN-POSTER-EU": 0.95 };
const pickables = [];
function buildShowroom() {
  const skus = [...state.catalog.keys()];
  skus.forEach((sku, i) => {
    const angle = (i - (skus.length - 1) / 2) * 0.52;
    const x = Math.sin(angle) * 4.9, z = -Math.cos(angle) * 4.9 + 3.2;
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.9, 0.6, 48),
      new THREE.MeshStandardMaterial({ color: 0x2a2458, roughness: 0.6, metalness: 0.2 }),
    );
    pedestal.position.set(x, 0.3, z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: 0x5ee7df, transparent: true, opacity: 0 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 0.62, z);
    const group = (SHAPES[sku] ?? SHAPES["SYN-HOODIE-01"])();
    const baseY = REST_Y[sku] ?? 1.3;
    group.position.set(x, baseY, z);
    group.userData.sku = sku;
    group.traverse((o) => (o.userData.sku = sku));
    scene.add(pedestal, ring, group);
    pickables.push(group, pedestal);
    pedestal.userData.sku = sku;
    const label = document.createElement("div");
    label.className = "label";
    stage.append(label);
    products.set(sku, { group, pedestal, ring, label, baseY, labelY: LABEL_Y[sku] ?? 1.2, phase: i });
    recolor(sku, state.catalog.get(sku).variants[0].variantId);
    updateLabel(sku);
  });
}
function recolor(sku, variantId) {
  const p = products.get(sku);
  if (!p) return;
  p.group.traverse((o) => {
    if (o.isMesh && o.material?.color && o.material.metalness <= 0.1) o.material.color.setHex(VARIANT_COLOR[variantId] ?? 0xb490ff);
  });
  updateLabel(sku, variantId);
}
function updateLabel(sku, variantId) {
  const item = state.catalog.get(sku);
  const v = variantId ? variantOf(sku, variantId) : item.variants[0];
  products.get(sku).label.innerHTML = `<b>${item.title}</b> · ${money(v.unitPriceMinor, item.currency)}`;
}

const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;
function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  const hit = ray.intersectObjects(pickables, true)[0];
  return hit?.object.userData.sku ?? null;
}
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const sku = pick(e);
  if (!sku) return;
  const item = state.catalog.get(sku);
  state.selected = { sku, variantId: item.variants[0].variantId };
  state.qty = 1;
  recolor(sku, state.selected.variantId);
  renderSelected();
  controls.autoRotate = false;
});
renderer.domElement.addEventListener("pointermove", (e) => {
  hovered = pick(e);
  renderer.domElement.style.cursor = hovered ? "pointer" : "grab";
});

function resize() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
function frame() {
  const t = clock.getElapsedTime();
  controls.update();
  const r = renderer.domElement.getBoundingClientRect();
  for (const [sku, p] of products) {
    const isSel = state.selected?.sku === sku;
    const inCart = state.view?.snapshot?.lines?.some((l) => l.sku === sku);
    if (!reduceMotion) {
      p.group.position.y = p.baseY + (isSel ? 0.12 + Math.sin(t * 1.6) * 0.06 : 0);
      p.group.rotation.y += isSel ? 0.012 : 0.004;
    }
    p.ring.material.opacity = isSel ? 0.95 : inCart ? 0.45 : hovered === sku ? 0.3 : 0;
    p.ring.material.color.setHex(isSel ? 0x5ee7df : 0xff8bd1);
    tmp.copy(p.group.position).setY(p.group.position.y + p.labelY).project(camera);
    p.label.style.left = `${((tmp.x + 1) / 2) * r.width}px`;
    p.label.style.top = `${((1 - tmp.y) / 2) * r.height}px`;
    p.label.classList.toggle("selected", isSel);
    p.label.style.display = tmp.z < 1 ? "" : "none";
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ───────────────────────────── boot ─────────────────────────────
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
  await reloadCatalog();
  state.world = await demoWorld(api);
  log("info", `Signed in as <b>${state.world.consumerId}</b>. ${state.world.appId} holds a signed access token; the AI helper may only draft carts.`);
  buildShowroom();
  resize();
  frame();
  renderSelected();
  renderCart();
}
boot().catch((e) => log("stop", "Startup failed.", e.code ?? "ERROR", e.message));
