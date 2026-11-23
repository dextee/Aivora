import test from "node:test";
import assert from "node:assert/strict";
process.env.AIVORA_MEMORY_MODE = "1";
const m = await import("../server/odai/po_persistence.mjs");

test("PP-01 offline mode: persistence is a no-op (local disk remains authoritative)", async () => {
  assert.equal(m.onlineEnabled(), false, "offline => not online-enabled");
  const r = await m.persistOrderOnline("demo-uncle-coffee-wellness", { id: "x", product_id: "p", quantity: 1 });
  assert.equal(r.persisted, false, "no remote write offline");
  const l = await m.loadOrdersOnline("demo-uncle-coffee-wellness");
  assert.equal(l, null, "no remote read offline");
});

test("PP-02 online without credentials fails closed (no memory fallback)", async () => {
  const prev = process.env.AIVORA_MEMORY_MODE; delete process.env.AIVORA_MEMORY_MODE;
  try {
    assert.equal(m.onlineEnabled(), false, "unconfigured => not enabled");
    const r = await m.persistOrderOnline("t", { id: "x" });
    assert.equal(r.persisted, false, "refuses to claim persistence without a live DB");
  } finally { if (prev !== undefined) process.env.AIVORA_MEMORY_MODE = prev; }
});
