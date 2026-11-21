import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const R = (p) => readFileSync(new URL(p, root), "utf8");

/* ---------- contract mirrors (ported 1:1 from pack tests/test_version90_contracts.py) ---------- */
describe("ODAI 9.0 contracts", () => {
  test("three modes + no permission escalation on switching", () => {
    const c = JSON.parse(R("odai/contracts/ui_modes_9_0.json"));
    assert.deepEqual(Object.keys(c.modes).sort(), ["management", "security", "user"]);
    assert.equal(c.mode_change_grants_permission, false);
    assert.equal(c.shared_backend, true);
    assert.equal(c.modes.security.simulation_label_required, true);
    assert.equal(c.modes.management.private_chain_of_thought, false);
  });
  test("ten beats, demo ends at 03:00", () => {
    const b = JSON.parse(R("odai/contracts/storyboard_10_beats_9_0.json"));
    assert.equal(b.length, 10);
    assert.equal(b.at(-1).end, "03:00");
    assert.ok(b.every((x) => x.demo_mode === "TEST" && x.requires_evidence === true));
    assert.deepEqual(b.map((x) => x.id).slice(0, 3), ["voice_objective", "qwenwork_orchestration", "product_research"]);
  });
  test("external writes default OFF for every connector", () => {
    const c = JSON.parse(R("odai/contracts/connector_readiness_9_0.json"));
    assert.ok(Object.values(c).every((v) => v.external_writes_enabled === false && v.approval_required === true));
  });
});

/* ---------- policy engine (M08 pattern) ---------- */
describe("policy engine R01-R19", () => {
  test("module import surface", async () => {
    const p = await import(new URL("server/odai/policy.mjs", root).href);
    assert.match(p.POLICY_VERSION, /R01-R19/);
    // R07: any discount → HOLD (APPROVE)
    const disc = p.evaluate("quote_price", { discountPct: 10, withinPriceList: true });
    assert.equal(disc.decision, "APPROVE");
    assert.equal(disc.rule, "R07");
    // R08: below written floor → NEVER (beats R07 by precedence)
    assert.equal(p.evaluate("quote_price", { discountPct: 10, withinPriceList: true, belowWrittenFloor: true }).decision, "NEVER");
    // R06 within list → ALLOW
    assert.equal(p.evaluate("quote_price", { discountPct: 0, withinPriceList: true }).decision, "ALLOW");
    // R11 invoice 5000 would HOLD — but pay_supplier is an external EFFECT, and the
    // 9.0 readiness contract (writes OFF) outranks the rule table: NEVER until the
    // provider permission bundle is verified. That is the intended precedence.
    assert.equal(p.evaluate("pay_supplier", { invoiceReceived: true, amountSgd: 5000 }).decision, "NEVER");
    // R10 invoice <1000 present — same connector gate applies
    assert.equal(p.evaluate("pay_supplier", { invoiceReceived: true, amountSgd: 900 }).decision, "NEVER");
    // R15 confidential upload → NEVER; public upload → connector gate NEVER too (writes off) — document both paths
    assert.equal(p.evaluate("upload_to_external_tool", { dataLevel: "confidential" }).decision, "NEVER");
    // unknown action fails CLOSED
    assert.equal(p.evaluate("mystery_action", {}).decision, "APPROVE");
    // mode access: no session → denied; switch grants read only
    assert.equal(p.modeAccess("user", {}).ok, false);
    const ok = p.modeAccess("management", { tenantId: "t1" });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.grants, ["read"]);
  });
});

/* ---------- HTTP flow (spawns the real staged server) ---------- */
describe("odai http workflow", () => {
  let child, base;
  before(async () => {
    const port = 8199;
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
      env: { ...globalThis.process.env, PORT: String(port), HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" },
      cwd: fileURLToPath(new URL(".", root)), stdio: "ignore",
    });
    const deadline = Date.now() + 15000;
    for (;;) {
      try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* wait */ }
      if (Date.now() > deadline) throw new Error("server did not boot");
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  after(() => child?.kill());

  const jget = async (p, init) => (await fetch(base + p, init)).json();

  test("catalog seed: 10 FNYGlobal items, all quarantined, none resale-authorized", async () => {
    const d = await jget("/api/odai/catalog");
    assert.equal(d.tenant_id, "demo-uncle-coffee-wellness");
    assert.equal(d.products.length, 10);
    assert.ok(d.products.every((p) => p.review_state === "QUARANTINED"));
    assert.ok(d.products.every((p) => p.reseller_authorized === false));
  });

  test("10-beat demo: gate at beat 5; approval resumes; watch blocks; TEST order; UNKNOWN profit", async () => {
    const start = await jget("/api/odai/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Sell FNYGlobal products to 100 customers" }) });
    assert.equal(start.awaiting, "spending_approval");
    assert.equal(start.steps.length, 5); // beats1-4 + held-5
    assert.equal(start.steps[4].decision, "APPROVE");

    const mv = await jget("/api/odai/view?mode=management");
    assert.equal(mv.data_mode, "TEST");
    assert.ok(mv.trace.length >= 5);
    assert.ok(mv.hub.includes("QwenWork"));

    const dec = await jget("/api/odai/demo/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: start.runId, approve: true, cap: 150 }) });
    assert.equal(dec.outcome, "RESUMED");
    const beat7 = dec.steps.find((s) => s.beat === 7);
    assert.equal(beat7.decision, "NEVER"); // invalid data blocked (connector gate + regulatory FAILED)
    assert.equal(beat7.evidence.watch_action, "REMOVED_BEFORE_DRAFT");
    const beat9 = dec.steps.find((s) => s.beat === 9);
    assert.equal(beat9.evidence.fulfillment.includes("PREPARED"), true);
    assert.equal(beat9.evidence.sent_to_supplier, false);
    const beat10 = dec.steps.find((s) => s.beat === 10);
    assert.equal(beat10.evidence.test_simulated.gross_profit, "UNKNOWN — supplier_cost null for ALL FNYGlobal items");

    // projection consistency across modes (shared backend)
    const uv = await jget("/api/odai/view?mode=user");
    assert.equal(uv.objective, "Sell FNYGlobal products to 100 customers");
    const sv = await jget("/api/odai/view?mode=security");
    assert.equal(sv.label, "AI Hacking Simulation");
    assert.equal(sv.shields.length, 6);
    assert.ok(sv.incidents.some((i) => i.decision === "NEVER"));
    assert.ok(sv.incidents.every((i) => i.simulation === "SIMULATED"));
  });

  test("decline path: stops after gate, no marketing beats", async () => {
    const start = await jget("/api/odai/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "GROW 30%" }) });
    const dec = await jget("/api/odai/demo/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: start.runId, approve: false }) });
    assert.equal(dec.outcome, "DECLINED_STOPPED");
    const mv = await jget("/api/odai/view?mode=management");
    const ids = mv.receipts.filter((r) => r.runId === start.runId).map((r) => r.beat);
    assert.ok(!ids.includes(6));
  });

  test("two-tenant isolation (WO-90-FLOW-002 / doc-13 §6)", async () => {
    await jget("/api/odai/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "TENANT-A-SECRET" }) });
    const other = await jget("/api/odai/view?mode=management&tenant=demo-other-tenant-42");
    assert.equal(other.tenant_id, "demo-other-tenant-42");
    assert.ok(!JSON.stringify(other).includes("TENANT-A-SECRET"));
    assert.equal(other.receipts.length, 0);
  });

  test("TGDO stand-in brand: Lumen Wellness present, clearly synthetic", async () => {
    const c = await jget("/api/odai/company");
    assert.equal(c.company.company_name, "Lumen Wellness");
    assert.equal(c.company.is_synthetic, true);
    assert.equal(c.company.profile_slot, "the-good-doctor-organization");
    const mv = await jget("/api/odai/view?mode=management");
    assert.equal(mv.company.name, "Lumen Wellness");
  });

  test("mode nav rejects unknown; grants never escalate", async () => {
    const r = await fetch(`${base}/api/odai/view?mode=superuser`);
    assert.equal(r.status, 403);
  });

  test("existing functionality intact: health + keyinfo + store bridge routes", async () => {
    assert.equal((await fetch(`${base}/api/health`)).ok, true);
    const ki = await jget("/api/keyinfo");
    assert.ok(["env", "none"].includes(ki.source));
    assert.equal((await jget("/api/store/diag")).hasOwnProperty("hashmeta_token"), true);
  });
});
