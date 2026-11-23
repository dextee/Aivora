/* Fixed Hashmeta storefront + PayPal BUY NOW — 10 mandatory integration tests.
 * Verifies protected config constants, all 5 products, exact PayPal destination,
 * honest payment-status lifecycle (link open != paid; verification needs evidence;
 * unverified excluded from revenue), and RogueAI payment/store destination protection.
 * The live Hashmeta storefront draft is verified separately via the authorized adapter. */
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HASHMETA_STORE_URL, PAYPAL_PAYMENT_URL } from "../server/odai/store_config.mjs";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let child;
const B = "http://127.0.0.1:8339";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());
before(async () => {
  child = spawn(process.execPath, [serverScript], { env: { ...process.env, PORT: "8339", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

const results = [];
function record(id, passed, detail) { results.push({ id, passed, detail }); assert.ok(passed, id + ": " + detail); }

test("SF-01 protected config constants are exact", async () => {
  const c = await getj("/api/odai/shop/config");
  record("SF-01", c.store_url === "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/zh/coffee-store" && c.paypal_url === "https://paypal.me/AntimosSG?locale.x=en_GB&COUNTY.X=SG" && c.protected === true, "store+paypal constants exact and protected");
  assert.equal(HASHMETA_STORE_URL, c.store_url);
  assert.equal(PAYPAL_PAYMENT_URL, c.paypal_url);
});

test("SF-02 all five coffee products present with approved prices", async () => {
  const j = await getj("/api/odai/shop/products");
  const names = j.products.map((p) => p.name);
  const expected = ["CEO Signature Coffee", "Tongkat Ali Coffee", "Vietnamese Heritage Coffee", "Nanyang Gold Kopi", "Mocha Reserve Coffee"];
  const ok = expected.every((n) => names.includes(n)) && j.products.length === 5;
  const prices = Object.fromEntries(j.products.map((p) => [p.name, p.approved_selling_price]));
  record("SF-02", ok && prices["Tongkat Ali Coffee"] === 24.9 && prices["Nanyang Gold Kopi"] === 19.9, "5 products, approved prices, no duplicates");
});

test("SF-03 BUY NOW destination equals the exact approved PayPal URL", async () => {
  const c = await getj("/api/odai/shop/config");
  record("SF-03", c.paypal_url === PAYPAL_PAYMENT_URL, "BUY NOW uses exact approved PayPal URL");
});

test("SF-04 opening the PayPal link is PAYMENT_PENDING, not paid", async () => {
  const j = (await post("/api/odai/shop/payment", { product_id: "COF-CEO-001", action: "open_link" })).body;
  record("SF-04", j.payment.status === "PAYMENT_PENDING" && j.paid === false, "link open => pending, not paid");
});

test("SF-05 verification without evidence stays PENDING (no paid receipt)", async () => {
  const j = (await post("/api/odai/shop/payment", { product_id: "COF-CEO-001", action: "verify" })).body;
  record("SF-05", j.payment.status === "PAYMENT_PENDING" && j.paid === false, "no evidence => pending, no paid receipt");
});

test("SF-06 verification with provider evidence => PAYMENT_VERIFIED", async () => {
  const j = (await post("/api/odai/shop/payment", { product_id: "COF-CEO-001", action: "verify", evidence: { verified: true, provider_reference: "PAYPAL-TXN-123", amount: 21.9 } })).body;
  record("SF-06", j.payment.status === "PAYMENT_VERIFIED" && j.paid === true && j.payment.provider_reference === "PAYPAL-TXN-123", "verified against provider evidence");
});

test("SF-07 only verified payments count as collected revenue", async () => {
  await post("/api/odai/shop/payment", { product_id: "COF-TKA-002", action: "open_link" }); /* pending, unverified */
  const j = await getj("/api/odai/shop/payments");
  record("SF-07", j.revenue.collected_revenue === 21.9 && j.revenue.verified_count === 1 && j.revenue.pending_count >= 1, "unverified pending excluded from revenue");
});

test("SF-08 RogueAI blocks alternative PayPal destination + records incident", async () => {
  const j = (await post("/api/odai/shop/payment-guard-test", { agent_id: "rogue-agent", proposed_url: "https://paypal.me/attacker" })).body;
  record("SF-08", j.blocked === true && j.preserved_paypal === PAYPAL_PAYMENT_URL && j.incident.violations.includes("payment_destination_manipulation"), "alternative PayPal blocked, approved preserved, incident recorded");
});

test("SF-09 RogueAI blocks alternative storefront URL", async () => {
  const j = (await post("/api/odai/shop/payment-guard-test", { agent_id: "rogue-agent", proposed_store_url: "https://evil.example/store" })).body;
  record("SF-09", j.blocked === true && j.preserved_store === HASHMETA_STORE_URL && j.incident.violations.includes("unapproved_website_change"), "alternative store URL blocked, approved preserved");
});

test("SF-10 refund => PAYMENT_REFUNDED, excluded from collected revenue", async () => {
  await post("/api/odai/shop/payment", { product_id: "COF-CEO-001", action: "refund" });
  const j = await getj("/api/odai/shop/payments");
  const refunded = j.payments.find((p) => p.product_id === "COF-CEO-001");
  record("SF-10", refunded.status === "PAYMENT_REFUNDED" && j.revenue.collected_revenue === 0, "refunded excluded from revenue");
});

test("DEV-11 independent verification of the 10 cases", () => {
  const rejected = results.filter((r) => !r.passed);
  assert.equal(rejected.length, 0, "DEV-11 rejected: " + JSON.stringify(rejected));
  assert.equal(results.length, 10, "all 10 mandatory cases executed");
  /* independent re-check of the protected constants (not trusting the runner) */
  assert.equal(PAYPAL_PAYMENT_URL, "https://paypal.me/AntimosSG?locale.x=en_GB&COUNTY.X=SG");
  assert.equal(HASHMETA_STORE_URL, "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/zh/coffee-store");
});