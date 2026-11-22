/* My Shop — SETUP_ONLINE_SHOP live execution line + structured output + RogueAI price guard.
 * Honest external states: link ok, catalog-sync PENDING, verification PARTIAL, publication draft. */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let child;
const B = "http://127.0.0.1:8325";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());

before(async () => {
  child = spawn(process.execPath, [serverScript], { env: { ...process.env, PORT: "8325", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

test("runShop produces structured output + 11 live execution events (honest externals)", async () => {
  const r = await post("/api/odai/shop", { name: "AIVORA Coffee", language: "English" });
  const s = r.body;
  assert.ok(s.store_id, JSON.stringify(s));
  assert.equal(s.execution_events.length, 11, "11 tasks");
  assert.equal(s.product_count, 5);
  assert.equal(s.currency, "SGD");
  assert.equal(s.products.find((p) => /tongkat/i.test(p.name)).price, 24.90, "approved SGD price preserved");
  assert.equal(s.logo_asset_id, "/logo.png", "existing logo reused, not fabricated");
  // honest external states
  assert.equal(s.integration_status, "linked");
  assert.ok(s.unresolved_blockers.some((b) => /EXTERNAL_CATALOG_SYNCHRONIZATION.*PENDING/.test(b)), "sync marked PENDING, not PASS");
  assert.equal(s.verification_status, "partially_verified");
  assert.match(s.publication_status, /draft/);
  assert.equal(s.order_capture_status, "sandbox_enabled");
  const t02 = s.execution_events.find((e) => e.task === "Create business logo");
  assert.equal(t02.status, "reused");
});

test("voice/text shop-setup routes through the unified /submit", async () => {
  const r = await post("/api/odai/submit", { text: "Help me set up my online coffee shop.", request_id: "shop-voice", source: "voice" });
  assert.ok(r.body.store_id, JSON.stringify(r.body));
  assert.equal(r.body.execution_events.length, 11);
});

test("RogueAI Shield blocks unauthorized price manipulation and preserves approved SGD", async () => {
  const s = await getj("/api/odai/shop");
  const tongkat = s.products.find((p) => /tongkat/i.test(p.name));
  const bad = await post("/api/odai/shop/price-test", { agent: "mkt-untrusted", product_id: tongkat.id, new_price: 15, approved: false });
  assert.equal(bad.body.blocked, true);
  assert.equal(bad.body.preserved_price_sgd, 24.90, "approved price preserved");
  assert.match(bad.body.incident.action, /BLOCKED_QUARANTINED/);
});
