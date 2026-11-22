/* My Shop (MAIN-FIX) — V43 dropshipping-catalog-driven SETUP_ONLINE_SHOP + animated console.
 * Verifies: master is source of truth, 13-step macro line, granular console_events from REAL ops,
 * honest externals (never faked completed), exact /zh/ storefront URL, weighted progress, QR,
 * add/remove = unlink only, RogueAI price guard. */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let child;
const B = "http://127.0.0.1:8326";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());

before(async () => {
  child = spawn(process.execPath, [serverScript], { env: { ...process.env, PORT: "8326", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

test("Dropshipping Product List is the authoritative source (5 products, approved SGD)", async () => {
  const m = await getj("/api/odai/shop/products");
  assert.equal(m.products.length, 5);
  assert.equal(m.products.find((p) => /tongkat/i.test(p.name)).approved_selling_price, 24.90);
});

test("runShop: 13 macro steps + granular console_events from real ops; honest externals", async () => {
  const s = (await post("/api/odai/shop", { name: "AIVORA Coffee", language: "English", currency: "SGD" })).body;
  assert.equal(s.execution_events.length, 13, "13 macro steps");
  assert.equal(s.product_count, 5);
  assert.equal(s.marketing_message, "Great Premium Coffee Every Morning");
  assert.ok(Array.isArray(s.console_events) && s.console_events.length > 40, "granular console stream");
  const phases = new Set(s.console_events.map((e) => e.phase));
  for (const p of ["objective", "agents", "catalog", "brand", "pricing", "assets", "security", "storefront", "completion"]) assert.ok(phases.has(p), `phase ${p}`);
  // every product loaded + priced from master, honestly
  assert.ok(s.console_events.some((e) => /Tongkat Ali Coffee — S\$24\.90/.test(e.line)), "real price line");
  // external accessibility/presentation are NEVER claimed completed (no fabrication)
  const ext = s.console_events.filter((e) => /accessibility|presentation/i.test(e.line));
  assert.ok(ext.length >= 2);
  assert.ok(ext.every((e) => !["completed", "verified"].includes(e.status)), "external checks stay pending/partial");
  assert.ok(!s.console_events.some((e) => /published|synced successfully|external publish/.test(e.line)), "no fake publish claim");
  assert.equal(s.integration_status, "linked");
  assert.match(s.store_url, /\/zh\/coffee-store$/, "exact approved storefront URL");
  assert.equal(s.logo_asset_id, "/logo.png", "existing logo reused, not fabricated");
  assert.ok(typeof s.progress === "number" && s.progress > 0 && s.progress < 100, "weighted progress < 100 while external pending");
});

test("remove unlinks from the shop only; master list preserved; add re-links", async () => {
  const s = await getj("/api/odai/shop");
  const one = s.products[0];
  const rem = await post("/api/odai/shop/remove", { product_id: one.product_id });
  assert.equal(rem.body.product_count, 4);
  assert.equal(rem.body.master_preserved, true);
  assert.equal((await getj("/api/odai/shop/products")).products.length, 5, "master NOT deleted by shop removal");
  const add = await post("/api/odai/shop/add", { product_ids: [one.product_id] });
  assert.equal(add.body.product_count, 5);
});

test("voice/text 'open an online shop' routes through unified /submit", async () => {
  const r = await post("/api/odai/submit", { text: "Help me open an online shop.", request_id: "shop-voice", source: "voice" });
  assert.ok(r.body.store_id, JSON.stringify(r.body));
  assert.ok(r.body.console_events.length > 40);
});

test("store QR endpoint returns a real scannable SVG data URL for the exact storefront", async () => {
  const j = await getj("/api/odai/shop/qr");
  assert.match(j.url, /\/zh\/coffee-store$/);
  assert.match(j.data_url, /^data:image\/svg\+xml;base64,/);
  assert.ok(Buffer.from(j.data_url.split(",")[1], "base64").toString("utf8").includes("<svg"), "valid svg");
});

test("RogueAI Shield blocks unauthorized price change and preserves approved SGD", async () => {
  const s = await getj("/api/odai/shop");
  const t = s.products.find((p) => /tongkat/i.test(p.name));
  const bad = await post("/api/odai/shop/price-test", { agent: "mkt-untrusted", product_id: t.product_id, new_price: 15, approved: false });
  assert.equal(bad.body.blocked, true);
  assert.equal(bad.body.preserved_price, 24.90);
  assert.match(bad.body.incident.action, /BLOCKED_QUARANTINED/);
});
