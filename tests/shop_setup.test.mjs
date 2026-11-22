/* My Shop (MAIN-FIX) — dropshipping-catalog-driven SETUP_ONLINE_SHOP.
 * Verifies: master list source of truth (not hard-coded), 13-step execution line, associations,
 * add/remove = unlink only (master preserved), approved SGD prices, honest externals, RogueAI guard. */
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

test("runShop builds a 13-step execution line + associations from the master (not hard-coded)", async () => {
  const r = await post("/api/odai/shop", { name: "AIVORA Coffee", language: "English", currency: "SGD" });
  const s = r.body;
  assert.equal(s.execution_events.length, 13, "13 steps");
  assert.equal(s.product_count, 5);
  assert.equal(s.currency, "SGD");
  assert.equal(s.logo_asset_id, "/logo.png", "existing logo reused, not fabricated");
  assert.equal(s.integration_status, "linked");
  assert.equal(s.verification_status, "partially_verified");
  assert.match(s.publication_status, /draft/);
  assert.ok(s.unresolved_blockers.some((b) => /EXTERNAL_CATALOG_SYNCHRONIZATION.*PENDING/.test(b)), "sync PENDING, not PASS");
});

test("remove unlinks from the shop only; master list preserved; add re-links", async () => {
  const s = await getj("/api/odai/shop");
  const one = s.products[0];
  const rem = await post("/api/odai/shop/remove", { product_id: one.product_id });
  assert.equal(rem.body.product_count, 4);
  assert.equal(rem.body.master_preserved, true);
  const m = await getj("/api/odai/shop/products");
  assert.equal(m.products.length, 5, "master NOT deleted by shop removal");
  const add = await post("/api/odai/shop/add", { product_ids: [one.product_id] });
  assert.equal(add.body.product_count, 5);
});

test("voice/text 'open an online shop' routes through unified /submit", async () => {
  const r = await post("/api/odai/submit", { text: "Help me open an online shop.", request_id: "shop-voice", source: "voice" });
  assert.ok(r.body.store_id, JSON.stringify(r.body));
  assert.equal(r.body.execution_events.length, 13);
});

test("RogueAI Shield blocks unauthorized price change and preserves approved SGD", async () => {
  const s = await getj("/api/odai/shop");
  const t = s.products.find((p) => /tongkat/i.test(p.name));
  const bad = await post("/api/odai/shop/price-test", { agent: "mkt-untrusted", product_id: t.product_id, new_price: 15, approved: false });
  assert.equal(bad.body.blocked, true);
  assert.equal(bad.body.preserved_price, 24.90);
  assert.match(bad.body.incident.action, /BLOCKED_QUARANTINED/);
});
