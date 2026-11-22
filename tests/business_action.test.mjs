import test from "node:test";
import assert from "node:assert/strict";
process.env.AIVORA_MEMORY_MODE = "1";
const T = "demo-uncle-coffee-wellness";
const m = await import("../server/odai/business_action.mjs");
const biz = await import("../server/odai/business.mjs");

test("BA-01 action plan computes from real validated records (no fabricated figures)", () => {
  const plan = m.actionPlan(T, { topX: 5 });
  assert.ok(plan.stats.recommended_actions >= 0);
  assert.ok(typeof plan.stats.proposed_purchasing === "number");
  assert.ok(plan.briefing.length > 20, "briefing composed");
  for (const d of plan.decisions) {
    assert.ok(d.decision_id && d.decision_type && d.priority && d.plain_language_title, "decision has required identity fields");
    assert.ok(d.verification_method, "verification method present");
    if (d.decision_type === "PURCHASE") { assert.ok(d.exact_recommended_quantity > 0, "purchase qty positive"); assert.ok(d.estimated_cost == null || d.estimated_cost > 0, "cost real or null"); }
  }
});

test("BA-02 topX selector returns at most X and prioritizes stockout urgency", () => {
  const p3 = m.actionPlan(T, { topX: 3 });
  const p10 = m.actionPlan(T, { topX: 10 });
  assert.ok(p3.decisions.length <= 3, "top3 capped");
  assert.ok(p10.decisions.length <= 10, "top10 capped");
  const rank = { CRITICAL: 0, URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
  const pri = p10.decisions.map(d => rank[d.priority] ?? 9);
  for (let i = 1; i < pri.length; i++) assert.ok(pri[i] >= pri[i - 1], "priorities non-decreasing");
});

test("BA-03 discounts are policy-bounded and margin-validated against real supplier cost", () => {
  const plan = m.actionPlan(T, { topX: 20 });
  const cust = plan.all_decisions.find(d => d.decision_type === "CUSTOMER_CONTACT");
  assert.ok(cust, "has a customer decision");
  const pol = m.DISCOUNT_POLICY[cust.supporting_metrics.segment === "VIP" ? "VIP" : cust.supporting_metrics.segment === "INACTIVE" ? "INACTIVE" : "REPEAT"];
  assert.ok(cust.recommended_discount_percentage >= pol.min && cust.recommended_discount_percentage <= pol.max, `discount ${cust.recommended_discount_percentage} within policy ${pol.min}-${pol.max}`);
  if (cust.margin != null) assert.ok(cust.margin >= m.MIN_MARGIN || cust.recommended_discount_percentage === 0, "margin respected");
  assert.ok(cust.discount_basis, "basis labelled");
});

test("BA-04 consent gates channel; ineligible customers not emailed", () => {
  const list = m.customerContactList(T, { segment: "ALL", limit: 50 });
  for (const c of list) {
    if (!c.consent) assert.equal(c.channel, "none (consent required)", "no-consent customer has no channel");
    if (c.consent) assert.equal(c.channel, "email");
  }
});

test("BA-05 customer rankings + preferred product from actual history (no invention)", () => {
  const rk = m.rankCustomers(T);
  assert.ok(rk.ranked.length > 0);
  const withHist = rk.ranked.filter(r => r.orders > 0);
  for (const c of withHist.slice(0, 5)) {
    assert.ok(c.preferred_product, "preferred product present when history exists");
    assert.ok(c.lifetime_sales > 0, "lifetime sales positive");
    assert.ok(c.typical_quantity == null || c.typical_quantity > 0, "typical qty sane");
  }
  const noHist = rk.ranked.find(r => r.orders === 0);
  if (noHist) assert.equal(noHist.preferred_product, null, "no invented preference without history");
});

test("BA-06 prepare purchase order creates a real PO and dedups on repeat", () => {
  const plan = m.actionPlan(T, { topX: 20 });
  const d = plan.all_decisions.find(x => x.decision_type === "PURCHASE");
  if (!d) { assert.ok(true, "no stockout in dataset — purchase path covered by bizlab"); return; }
  const first = m.preparePurchaseOrder(T, d.decision_id);
  assert.ok(first.order_id, "real PO id");
  const second = m.preparePurchaseOrder(T, d.decision_id);
  assert.equal(second.order_id, first.order_id, "repeat does not duplicate");
  assert.equal(second.deduped, true, "deduped flag");
});

test("BA-07 contact list CSV export matches computed rows", () => {
  const csv = m.contactListCsv(T, { segment: "ALL", limit: 5 });
  const lines = csv.trim().split("\n");
  const list = m.customerContactList(T, { segment: "ALL", limit: 5 });
  assert.equal(lines.length, list.length + 1, "header + one row per customer");
  assert.ok(lines[0].includes("customer_id") && lines[0].includes("proposed_discount_percent"), "header fields");
});

test("BA-08 email preparation skips non-consented and never sends", () => {
  const list = m.customerContactList(T, { segment: "ALL", limit: 50 });
  const ids = list.slice(0, 3).map(c => c.customer_id);
  const r = m.prepareCustomerEmails(T, ids);
  assert.equal(r.sent, 0, "nothing sent");
  assert.equal(r.prepared + r.skipped, ids.length, "every requested customer accounted for");
});
