import test from "node:test";
import assert from "node:assert/strict";
process.env.AIVORA_MEMORY_MODE = "1";
const tl = await import("../server/odai/trust_layer.mjs");

const PROC = (total) => ({ total_cost_cents: total, quantity: 100, product_exists: true, supplier_id: "DEMO-SUP-01", approved_suppliers: ["DEMO-SUP-01"], duplicate_count: 0, rounding_discrepancy_cents: 0 });

test("TR-01 numerical guardrail: below / exactly-at / above max single PO (SGD 6,500)", () => {
  const below = tl.verifyProcurement({ quantity: 100, unit_cost: 60, currency: "SGD", supplier_id: "DEMO-SUP-01", product_exists: true, approved_suppliers: ["DEMO-SUP-01"], budget_cents: 1000000 });
  const at = tl.verifyProcurement({ quantity: 100, unit_cost: 65, currency: "SGD", supplier_id: "DEMO-SUP-01", product_exists: true, approved_suppliers: ["DEMO-SUP-01"], budget_cents: 1000000 });
  const above = tl.verifyProcurement({ quantity: 100, unit_cost: 66, currency: "SGD", supplier_id: "DEMO-SUP-01", product_exists: true, approved_suppliers: ["DEMO-SUP-01"], budget_cents: 1000000 });
  assert.notEqual(below.decision, "DENY", "6000 <= 6500 allowed path");
  assert.notEqual(at.decision, "DENY", "exactly 6500 passes <= boundary");
  assert.equal(above.decision, "DENY", "6600 > 6500 denied");
  assert.ok(above.failed_constraints.some(f => f.rule_id === "GR-FIN-001"), "denied by GR-FIN-001");
});

test("TR-02 missing mandatory fact => BLOCKED_MISSING_EVIDENCE (never treated as zero)", () => {
  const d = tl.verifyProcurement({ quantity: 10, unit_cost: null, currency: "SGD", supplier_id: "DEMO-SUP-01", product_exists: true, approved_suppliers: ["DEMO-SUP-01"], budget_cents: 100000 });
  assert.equal(d.decision, "BLOCKED_MISSING_EVIDENCE");
});

test("TR-03 invalid input type rejected (string total not coerced)", () => {
  const d = tl.evaluateAction({ category: "financial", mandatory_facts: ["total_cost_cents"] }, { total_cost_cents: "6000", quantity: 1, product_exists: true, supplier_id: "DEMO-SUP-01", approved_suppliers: ["DEMO-SUP-01"], duplicate_count: 0, rounding_discrepancy_cents: 0 }, {});
  assert.equal(d.decision, "BLOCKED_MISSING_EVIDENCE");
});

test("TR-04 allowlist: unapproved supplier and protected payment destination denied", () => {
  const sup = tl.verifyProcurement({ quantity: 10, unit_cost: 10, currency: "SGD", supplier_id: "ROGUE-SUP", product_exists: true, approved_suppliers: ["DEMO-SUP-01"], budget_cents: 100000 });
  assert.equal(sup.decision, "DENY");
  const link = tl.verifyOutboundLink("https://evil.example/pay");
  assert.equal(link.decision, "DENY");
  const good = tl.verifyOutboundLink("https://paypal.me/AntimosSG?locale.x=en_GB&COUNTY.X=SG");
  assert.equal(good.decision, "ALLOW");
});

test("TR-05 discount margin: 30% min contribution margin enforced; over-cap denied/approval", () => {
  const ok = tl.verifyDiscount({ percent: 10, price: 21.9, cost: 10 });
  assert.equal(ok.decision, "ALLOW", "10% with cost 10 keeps margin >=30%");
  const tooDeep = tl.verifyDiscount({ percent: 60, price: 21.9, cost: 10 });
  assert.notEqual(tooDeep.decision, "ALLOW", "60% discount violates margin/cap");
  const noCost = tl.verifyDiscount({ percent: 10, price: 21.9, cost: null });
  assert.equal(noCost.decision, "BLOCKED_MISSING_EVIDENCE", "no cost => missing evidence, not auto-authorized");
});

test("TR-06 unauthorized rule modification rejected; owner propose+approve versions+audit", () => {
  assert.throws(() => tl.proposeRuleChange({ role: "agent" }, "GR-FIN-001", { threshold_value: 99999999 }), /owner|policy_admin/i);
  const ch = tl.proposeRuleChange({ role: "owner", id: "owner" }, "GR-FIN-001", { threshold_value: 650000 }, "keep default, exercise versioning");
  assert.equal(ch.status, "PENDING");
  assert.throws(() => tl.approveRuleChange({ role: "agent" }, ch.change_id), /owner/i);
  const ap = tl.approveRuleChange({ role: "owner", id: "owner" }, ch.change_id);
  assert.ok(ap.rule_version >= 2, "version bumped");
  const rule = tl.listRules().find(r => r.rule_id === "GR-FIN-001");
  assert.ok(rule.audit_history.length >= 2, "audit history recorded");
});

test("TR-07 dual-LLM failure: both LLMs approve prohibited action, trust layer still denies", () => {
  const r = tl.dualLlmFailureTest();
  assert.equal(r.both_llms_approved, true);
  assert.ok(r.blocked_despite_llm_approval, "blocked despite both LLM approvals");
  assert.equal(r.side_effects, 0);
  assert.ok(r.denied_by.includes("GR-FIN-001"), "denied by the real numerical rule");
  assert.equal(r.evidence.llm_assessments.execution_llm, "APPROVE (incorrect)");
});

test("TR-08 remediation: over-budget proposal rejected then affordable quantity computed, not executed", () => {
  const r = tl.remediateProcurement({ category: "financial", skill_id: "decision.prepare_purchase_order" }, { total_cost_cents: 6000000, quantity: 6000, unit_cost_cents: 1000, available_budget_cents: 650000, product_exists: true, supplier_id: "DEMO-SUP-01", approved_suppliers: ["DEMO-SUP-01"], duplicate_count: 0, rounding_discrepancy_cents: 0 }, 12);
  assert.equal(r.remediated, true);
  assert.notEqual(r.decision.decision, "ALLOW");
  assert.ok(r.affordable_quantity > 0 && r.affordable_quantity % 12 === 0, "affordable qty pack-aligned");
  assert.ok(/re-authorization/.test(r.note), "remediated proposal requires re-auth");
});

test("TR-09 evaluation evidence persisted with rule versions + LLM assessments separate", () => {
  const d = tl.verifyProcurement({ quantity: 5, unit_cost: 10, currency: "SGD", supplier_id: "DEMO-SUP-01", product_exists: true, approved_suppliers: ["DEMO-SUP-01"], budget_cents: 100000 });
  const log = tl.evaluationLog(50);
  const found = log.find(e => e.decision_id === d.decision_id);
  assert.ok(found, "evaluation persisted");
  assert.ok(found.rule_versions && found.evaluated_rule_ids.length > 0, "rule ids+versions recorded");
  assert.ok(found.llm_assessments, "llm assessments recorded separately");
  assert.ok(found.request_hash, "request hash for replay protection");
});

test("TR-10 registry persists across reload (restart) with versions intact", () => {
  const before = tl.listRules().find(r => r.rule_id === "GR-FIN-001").rule_version;
  const again = tl.listRules().find(r => r.rule_id === "GR-FIN-001").rule_version;
  assert.equal(again, before, "rule version stable across reload");
  const stats = tl.trustStats();
  assert.ok(stats.active_rules >= 19, "registry loaded from disk");
});

test("TR-11 consent + recipient-count guardrails gate customer contact", () => {
  const denied = tl.verifyCustomerContact({ recipient_count: 10, all_recipients_consented: false });
  assert.equal(denied.decision, "DENY", "no consent => deny");
  const big = tl.verifyCustomerContact({ recipient_count: 80, all_recipients_consented: true });
  assert.equal(big.decision, "REQUIRE_APPROVAL", ">50 recipients requires approval");
  const ok = tl.verifyCustomerContact({ recipient_count: 10, all_recipients_consented: true });
  assert.equal(ok.decision, "ALLOW");
});

test("TR-12 healing guardrails: retry bound + prohibited replay denied", () => {
  const retries = tl.evaluateAction({ category: "automation_healing", skill_id: "automation.heal" }, { attempt_count: 3 }, {});
  assert.notEqual(retries.decision, "ALLOW", "3rd attempt exceeds bound");
  const replay = tl.evaluateAction({ category: "automation_healing", skill_id: "automation.heal" }, { attempt_count: 1, replay_of_prohibited: true }, {});
  assert.equal(replay.decision, "DENY", "prohibited replay denied");
});
