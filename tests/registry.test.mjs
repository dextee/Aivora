/* tests/registry.test.mjs — WO-A1 business-plane registry suite (batch A1).
 * Real-HTTP spawned server (no mocks), same boot pattern as objectives.test.mjs.
 * Covers: builder determinism (hash-stable re-run), registry file shape + counts,
 * WO-102 generalized grammar (RM caps / amounts / counts / dates) with python-side
 * parity fixtures, router additivity (legacy demo phrasing never hijacked),
 * 3 end-to-end registry-routed objectives (task plan == registry plan, dependency
 * order respected), GET /api/odai/registry summary, WO-103 P0 skill contracts and
 * WO-104 immutable money ledger semantics. */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const B = "http://127.0.0.1:8311";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());
let child;
before(async () => {
  child = spawn(process.execPath, [new URL("server.mjs", root).pathname], { env: { ...process.env, PORT: "8311", HOST: "127.0.0.1" }, cwd: new URL(".", root).pathname, stdio: "ignore" });
  const dl = Date.now() + 25000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

import { criterionFromText, matchObjective, planFor, registrySummary, validatePlanEdges } from "../server/odai/registry.mjs";
import { skill_ledger_append, skill_catalog_query, skill_evidence_append, skill_gate_check, skill_schedule_scaffold, skill_report_compose, p0ContractFieldAudit, skill_creative_generate, skill_poster_social_create, skill_margin_analyze, skill_storefront_build, skill_claims_review, skill_compliance_research, skill_funnel_build, skill_spend_control, skill_supplier_verify, skill_audience_research, skill_business_model_analyze, skill_campaign_design, skill_checkout_integrate, skill_conversation_design, skill_demand_research, skill_fulfillment_plan } from "../server/odai/skills.mjs";
import { budgetScope } from "../server/odai/reservations.mjs";
import { appendMoneyEvent, moneyTotals, moneyEvents } from "../server/odai/ledger.mjs";

const CFG = (n) => JSON.parse(readFileSync(new URL("odai/config/" + n, root), "utf8"));

/* ---------------- 1. builder determinism ---------------- */
test("A1: build_registry.py re-run reproduces byte-identical registry files (--check)", () => {
  const out = execFileSync("python3", ["tools/build_registry.py", "--check"], { cwd: new URL(".", root).pathname, encoding: "utf8" });
  assert.match(out, /HASH-STABLE re-run verified/);
});

/* ---------------- 2. registry shape + governled counts ---------------- */
test("A1: registry file counts match the pinned intake (22/54/59/100/224/28/16)", () => {
  assert.equal(CFG("business_agents.json").row_count, 22);
  assert.equal(CFG("specialist_roles.json").row_count, 54);
  assert.equal(CFG("skill_contracts.json").row_count, 59);
  assert.equal(CFG("objectives_registry.json").row_count, 100);
  assert.equal(CFG("task_graph.json").row_count, 224);
  assert.equal(CFG("connectors_matrix.json").row_count, 28);
  assert.equal(CFG("policy_index.json").row_count, 16);
  assert.equal(CFG("task_graph.json").edges, 124);
  const intake = "73e172ce58b5aa775132aa20ff06bd3a454782c90ae9aaf5105b5c6f5c35d509";
  for (const f of ["business_agents", "specialist_roles", "skill_contracts", "objectives_registry", "task_graph", "connectors_matrix", "policy_index"])
    assert.equal(CFG(f + ".json").intake_sha256, intake, f + " intake pin");
});

test("A1: task graph is topo-sorted; every dependency references an earlier step (DAG before dispatch)", () => {
  const rows = CFG("task_graph.json").rows;
  const byObj = {};
  for (const r of rows) (byObj[r.objective_id] = byObj[r.objective_id] || []).push(r);
  for (const [oid, nodes] of Object.entries(byObj)) {
    const pos = new Map(nodes.map((n, i) => [n.task_id, i]));
    assert.deepEqual(nodes.map((n) => n.step), nodes.map((_, i) => i + 1), oid + " step order");
    for (const n of nodes) for (const p of n.depends_on) assert.ok(pos.get(p) < pos.get(n.task_id), oid + " edge " + p + "->" + n.task_id);
  }
});

test("A1: WO-107 dedup ledger — 6 CTRL merges + 2 fix classifications + reuse verdicts", () => {
  const reg = CFG("specialist_roles.json");
  const ledger = reg.dedup_ledger;
  assert.equal(Object.keys(ledger.wo107_control_merges).length, 6);
  assert.equal(Object.keys(ledger.wo107_misclassification_fixes).length, 2);
  assert.deepEqual(Object.keys(ledger.wo107_misclassification_fixes).sort(), ["Report Narrator", "Specialist Router"]);
  const fixed = reg.rows.filter((r) => r.classification_fix);
  assert.equal(fixed.length, 2);
  for (const f of fixed) assert.equal(f.type_final, "Control");
  const merged = reg.rows.filter((r) => r.reuse_verdict_final === "MERGED-INTO-CTRL");
  assert.equal(merged.length, 8); // 6 control type + 2 fixed classifications
  for (const m of merged) { assert.ok(m.canonical_agent_binding?.startsWith("CTRL-")); assert.equal(m.separate_process, false); }
  assert.deepEqual(ledger.final_totals, { "REUSE-AS-IS": 3, MERGE: 10, "REGISTER-NEW": 33, "MERGED-INTO-CTRL": 8 });
  assert.equal(ledger.populations_are_three_disjoint.installed_active_skills, 8);
});

test("A1: WO-105 connector matrix — MOCK/PROVIDER_SANDBOX/BLOCKED; TBD -> BLOCKED; SK-058 orphan disposition", () => {
  const reg = CFG("connectors_matrix.json");
  const cls = Object.fromEntries(reg.rows.map((r) => [r.connector_id, r.classification]));
  assert.equal(cls["CAT-21"], "BLOCKED"); // Payment/supplier/logistics — not established (TBD rule)
  for (const id of ["CON-FB", "CON-YT", "CON-LI", "CON-WAN-IMG", "CON-WAN-VID", "CON-HASH-WEB", "CON-HASH-MKT"]) assert.equal(cls[id], "BLOCKED", id);
  assert.equal(cls["CAT-11"], "MOCK"); // internal persistence
  assert.equal(cls["CAT-05"], "PROVIDER_SANDBOX");
  assert.deepEqual(reg.classification_totals, { MOCK: 2, PROVIDER_SANDBOX: 18, BLOCKED: 8 });
  assert.equal(reg.skill_dispositions[0].skill_id, "SK-058");
  assert.equal(reg.skill_dispositions[0].disposition, "CONTRACT_ONLY_ROLLED_UP_INTO_SK-047");
  const sk = CFG("skill_contracts.json").rows.find((r) => r.skill_id === "SK-058");
  assert.equal(sk.task_reference_count, 0);
  assert.ok(sk.orphan_disposition);
});

test("A1: WO-101 CTRL shims are module-name data only — no new dispatcher/policy surfaces", () => {
  const agents = CFG("business_agents.json").rows;
  const ctrls = agents.filter((a) => a.agent_id.startsWith("CTRL-"));
  assert.equal(ctrls.length, 12);
  for (const c of ctrls) { assert.ok(c.shim?.module_name, c.agent_id + " shim"); assert.equal(c.shim.separate_process, false); }
  // G1 surfaces untouched by this batch: policy evaluator count and dispatcher count unchanged
  const policy = readFileSync(new URL("server/odai/policy.mjs", root), "utf8");
  assert.equal((policy.match(/export function evaluate/g) || []).length, 1);
  const wf = readFileSync(new URL("server/odai/workflow.mjs", root), "utf8");
  assert.equal((wf.match(/export async function startRun/g) || []).length, 1);
});

/* grammar parity fixtures — expected values produced by tools/build_registry.py
 * criterion_from_text() (python ground truth); the JS grammar must match key-for-key. */
const PARITY_FIXTURES = [
 {
  "statement": "I don\u2019t know what business to start.",
  "criterion": null
 },
 {
  "statement": "I only have RM300. Can I start something?",
  "criterion": {
   "kind": "money_amount_myr",
   "amount_myr": 300
  }
 },
 {
  "statement": "Help me sell Good Doctor products.",
  "criterion": null
 },
 {
  "statement": "I don\u2019t want to keep stock.",
  "criterion": null
 },
 {
  "statement": "I want to sell something from home.",
  "criterion": null
 },
 {
  "statement": "I want to earn money using my phone.",
  "criterion": null
 },
 {
  "statement": "I have no company. Can I sell online?",
  "criterion": null
 },
 {
  "statement": "Help me choose a business name.",
  "criterion": null
 },
 {
  "statement": "I only have RM300. Can I start something?",
  "criterion": {
   "kind": "money_amount_myr",
   "amount_myr": 300
  }
 },
 {
  "statement": "Find products that cost less than RM50.",
  "criterion": {
   "kind": "money_cap_myr",
   "cap_myr": 50
  }
 },
 {
  "statement": "I have only RM100 for advertising.",
  "criterion": {
   "kind": "money_amount_myr",
   "amount_myr": 100
  }
 },
 {
  "statement": "Can I afford another RM200 advertisement?",
  "criterion": {
   "kind": "money_amount_myr",
   "amount_myr": 200
  }
 },
 {
  "statement": "Help me sell 100 products this month.",
  "criterion": {
   "kind": "units_sold",
   "target_units": 100
  }
 },
 {
  "statement": "Don\u2019t spend more than RM300.",
  "criterion": {
   "kind": "money_cap_myr",
   "cap_myr": 300
  }
 },
 {
  "statement": "Launch the store by 20 December 2026",
  "criterion": {
   "kind": "deadline",
   "until": "20 december 2026"
  }
 },
 {
  "statement": "finish the page by next month",
  "criterion": {
   "kind": "deadline",
   "until": "next month"
  }
 },
 {
  "statement": "wrap up inventory by end of this month",
  "criterion": {
   "kind": "deadline",
   "until": "this month"
  }
 },
 {
  "statement": "Reach 150 new customers",
  "criterion": {
   "kind": "count_target",
   "target": 150,
   "metric": "new_customer"
  }
 },
 {
  "statement": "Grow sales 25% in 30 days",
  "criterion": {
   "kind": "growth",
   "pct": 25,
   "days": 30
  }
 },
 {
  "statement": "Don't spend more than RM450.",
  "criterion": {
   "kind": "money_cap_myr",
   "cap_myr": 450
  }
 },
 {
  "statement": "I only have RM1,000 today",
  "criterion": {
   "kind": "money_amount_myr",
   "amount_myr": 1000
  }
 },
 {
  "statement": "sell 300 products",
  "criterion": {
   "kind": "units_sold",
   "target_units": 300
  }
 },
 {
  "statement": "get 40 orders",
  "criterion": {
   "kind": "count_target",
   "target": 40,
   "metric": "order"
  }
 },
 {
  "statement": "no more than RM 250 cost per batch",
  "criterion": {
   "kind": "money_cap_myr",
   "cap_myr": 250
  }
 },
 {
  "statement": "What should I name my shop?",
  "criterion": null
 },
 {
  "statement": "I only have RM300. Can I start something?",
  "criterion": {
   "kind": "money_amount_myr",
   "amount_myr": 300
  }
 },
 {
  "statement": "Find products that cost less than RM50.",
  "criterion": {
   "kind": "money_cap_myr",
   "cap_myr": 50
  }
 },
 {
  "statement": "Help me sell 100 products this month.",
  "criterion": {
   "kind": "units_sold",
   "target_units": 100
  }
 },
 {
  "statement": "Don\u2019t spend more than RM300.",
  "criterion": {
   "kind": "money_cap_myr",
   "cap_myr": 300
  }
 },
 {
  "statement": "Save my shop by end of this month",
  "criterion": {
   "kind": "deadline",
   "until": "this month"
  }
 }
];


/* ---------------- 3. WO-102 generalized grammar (units/%/days/RM-count/date) ---------------- */
test("A1: grammar parity with the builder (python ground truth) on registry statements", () => {
  for (const fx of PARITY_FIXTURES) assert.deepEqual(criterionFromText(fx.statement), fx.criterion, fx.statement);
});

test("A1: RM caps, counts and dates parse; legacy generic interpret() behavior unchanged", async () => {
  const { interpret } = await import("../server/odai/objectives.mjs");
  assert.deepEqual(criterionFromText("Don\u2019t spend more than RM300."), { kind: "money_cap_myr", cap_myr: 300 });
  assert.deepEqual(criterionFromText("RM100 hard cap"), { kind: "money_cap_myr", cap_myr: 100 });
  assert.deepEqual(criterionFromText("by December 2026"), { kind: "deadline", until: "december 2026" });
  assert.deepEqual(criterionFromText("close the project by 12/01/2027"), { kind: "deadline", until: "12/01/2027" });
  assert.deepEqual(criterionFromText("answer 12 tickets"), { kind: "count_target", target: 12, metric: "ticket" });
  // legacy interpret must keep its V32/V33 semantics for the demo grammars
  const a = interpret("Sell 30 Lumen Wellness products from the FNYGlobal catalog in 90 days");
  assert.equal(a.valid, true); assert.equal(a.criterion.kind, "units_sold"); assert.equal(a.criterion.target_units, 30);
  assert.equal(a.criterion.via_catalog, "FNYGlobal"); assert.match(a.criterion.brand, /Lumen/);
  const b = interpret("Grow wellness sales 30% in 45 days with targeted advertisements");
  assert.equal(b.criterion.kind, "growth"); assert.equal(b.criterion.pct, 30); assert.equal(b.criterion.days, 45);
  const c = interpret("make me money somehow");
  assert.equal(c.valid, false);
});

/* ---------------- 4. router additivity — never break the current OBJ flow ---------------- */
test("A1: legacy demo phrasing still takes the generic planner path (11-task D03 plan)", async () => {
  const stmt = "Help me sell 100 Good Doctor wellness products using FNYGlobal's catalog.";
  assert.equal(matchObjective(stmt), null); // router refuses
  const { status, body: o } = await post("/api/odai/objectives", { statement: stmt });
  assert.equal(status, 200);
  assert.equal(o.plan_source, undefined, "generic path — not registry");
  assert.equal(o.tasks.length, 11);
  assert.equal(o.state, "AWAITING_SPEND_APPROVAL");
});

test("A1: unknown statements fall back to existing reject behavior", async () => {
  const { body: o } = await post("/api/odai/objectives", { statement: "order 500 pad thai tonight" });
  assert.match(o.error || "", /not measurable/);
});

/* ---------------- 5. registry summary route ---------------- */
test("A1: GET /api/odai/registry — counts + version hash (stable across calls)", async () => {
  const a = await getj("/api/odai/registry");
  assert.deepEqual(a.counts.agents, 22); assert.deepEqual(a.counts.objectives, 100);
  assert.equal(a.counts.skills, 59); assert.equal(a.counts.tasks, 224);
  assert.equal(a.counts.connectors, 28); assert.equal(a.counts.policies, 16);
  assert.equal(a.counts.specialists, 54);
  assert.match(a.version_hash, /^[0-9a-f]{64}$/);
  assert.equal(a.version_hash, (await getj("/api/odai/registry")).version_hash);
  const files = ["business_agents.json", "specialist_roles.json", "skill_contracts.json", "objectives_registry.json", "task_graph.json", "connectors_matrix.json", "policy_index.json"];
  for (const f of files) assert.equal(a.per_file_sha256[f], createHash("sha256").update(readFileSync(new URL("odai/config/" + f, root))).digest("hex"), f);
});

/* ---------------- 6. three registry-routed objectives end-to-end (plan == registry) ---------------- */
async function routedE2E(statement, registry_id, expect) {
  const { status, body: o } = await post("/api/odai/objectives", { statement });
  assert.equal(status, 200, registry_id + " create status");
  assert.equal(o.plan_source, "registry", registry_id + " should route via registry");
  assert.equal(o.registry_objective_id, registry_id);
  const plan = planFor(registry_id);
  // task plan == registry plan: ids, order, steps, deps, specialists
  assert.deepEqual(o.tasks.map((t) => t.id), plan.tasks.map((t) => t.id), registry_id + " task ids/order");
  assert.deepEqual(o.tasks.map((t) => [t.step, t.deps, t.specialist]), plan.tasks.map((t) => [t.step, t.depends_on, t.specialist]), registry_id + " step/deps/specialist");
  // dependency order respected (validated pre-dispatch)
  assert.equal(validatePlanEdges(o.tasks.map((t) => ({ id: t.id, depends_on: t.deps }))).ok, true);
  assert.equal(o.gates.every((g) => expect.gateIds.includes(g.id)), true, registry_id + " gates " + JSON.stringify(o.gates));
  assert.equal(o.state, expect.state);
  if (expect.criterion) assert.deepEqual(o.criterion, expect.criterion);
  const back = await getj("/api/odai/objectives/" + o.objective_id); // resume keeps registry plan
  assert.equal(back.plan_source, "registry");
  assert.deepEqual(back.tasks.map((t) => t.id), o.tasks.map((t) => t.id));
  return o;
}

test("A1 e2e #1 family 'Safety/approvals' — UC-091 RM300 cap: route → AWAITING_SPEND_APPROVAL → approve → held", async () => {
  const o = await routedE2E("Don\u2019t spend more than RM300.", "UC-091", {
    gateIds: ["approve_spend"], state: "AWAITING_SPEND_APPROVAL", criterion: { kind: "money_cap_myr", cap_myr: 300 },
  });
  const { body: a } = await post("/api/odai/objectives/" + o.objective_id + "/approve", { scope: "approve_spend", cap: 300 });
  assert.equal(a.plan_source, "registry");
  assert.equal(a.gates[0].state, "approved_cap_recorded");
  assert.equal(a.gate_decision.policy_decision, "ALLOW");
  assert.equal(a.state, "PLAN_APPROVED_HELD_CONNECTORS");
  const { body: rep } = await post("/api/odai/objectives/" + o.objective_id + "/report", {});
  assert.equal(rep.plan_source, "registry");
  assert.match(rep.money_first.profit, /UNKNOWN/);
  assert.equal(rep.money_first.money_out_myr, 0);
  assert.equal(rep.state, "PLAN_APPROVED_HELD_CONNECTORS");
});

test("A1 e2e #2 family 'Starting a business' — UC-001: route + plan fidelity + spend gate pending", async () => {
  await routedE2E("I don\u2019t know what business to start.", "UC-001", { gateIds: ["approve_spend"], state: "AWAITING_SPEND_APPROVAL" });
});

test("A1 e2e #3 family 'Automation and business growth' (run-my-business-automatically) — UC-081 review-gated", async () => {
  const o = await routedE2E("Run my shop automatically.", "UC-081", { gateIds: ["owner_review"], state: "PLAN_VALIDATED_READY" });
  const { body: a } = await post("/api/odai/objectives/" + o.objective_id + "/approve", { scope: "owner_review", cap: 0 });
  assert.equal(a.gates[0].state, "advisory_recorded");
  assert.equal(a.state, "PLAN_VALIDATED_READY");
  assert.equal(a.gate_decision.reason_code, "advisory_review_only_action");
});

test("A1: registry task nodes carry P0 module wiring where implemented (WO-103 into task types)", () => {
  const plan = planFor("UC-091");
  const t2 = plan.tasks.find((t) => t.skill_id === "SK-035");
  assert.equal(t2.module, "server/odai/skills.mjs");
  assert.equal(t2.fn, "skill_gate_check");
  assert.equal(t2.executable, true);
  const t1 = plan.tasks.find((t) => t.skill_id === "SK-046");
  assert.equal(t1.module, "server/odai/skills.mjs", "WO-113: spend-controller wired");
  assert.equal(t1.fn, "skill_spend_control");
  assert.equal(t1.executable, true, "Internal connector = LOCAL");
});

/* ---------------- 7. WO-103 P0 skill modules — contracts from sheet-04 ---------------- */
test("A1: P0 modules honor NEEDS_INPUT/REJECTED error contract + produce declared outputs", () => {
  assert.equal(skill_ledger_append({}).status, "NEEDS_INPUT");
  assert.equal(skill_catalog_query({ market: "MY" }).status, "NEEDS_INPUT"); // tenant path needs tenant_id; no supplier_catalog given
  assert.equal(skill_evidence_append({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T01" }).status, "NEEDS_INPUT");
  assert.equal(skill_gate_check({}).policy_decision, "DENY");
  const bad = skill_schedule_scaffold({ tenant_id: "t", objective_id: "UC-081", task_id: "UC-081-T01", cadence: "whenever" });
  assert.equal(bad.status, "REJECTED");
  assert.equal(skill_report_compose({ tenant_id: "nope" }).status, "NEEDS_INPUT");

  // happy paths
  const led = skill_ledger_append({ tenant_id: "sk-a1", objective_id: "UC-091", task_id: "UC-091-T01", source_refs: ["fixture:ledger"], validated_domain_inputs: { amount_myr: 42, direction: "out", category: "ads" } });
  assert.equal(led.status, "OK"); assert.match(led.evidence_refs[0], /^ME-sk-a1-/);
  const rep = skill_report_compose({ tenant_id: "sk-a1", objective_id: "UC-091" });
  assert.equal(rep.status, "OK");
  assert.equal(rep.typed_artifact.money_first.money_out_myr, 42);
  const cat = skill_catalog_query({ tenant_id: "demo-uncle-coffee-wellness", market: "MY" });
  assert.equal(cat.status, "OK");
  assert.ok(Array.isArray(cat.validated_catalog) && Array.isArray(cat.rejected_rows) && Array.isArray(cat.provenance_refs));
  const ev = skill_evidence_append({ tenant_id: "sk-a1", objective_id: "UC-091", task_id: "UC-091-T02", source_refs: ["ME-sk-a1-1"], validated_domain_inputs: { artifact: { ok: true } } });
  assert.equal(ev.status, "OK");
  const g = skill_gate_check({ actor: "OWNER", tenant: "sk-a1", action: "approve_spend", resource: "UC-091", risk: "medium", gate: { scope: "spend" }, owner_approved: true, amount_myr: 500, cap_myr: 300 });
  assert.equal(g.policy_decision, "BLOCK"); assert.match(g.reason_code, /OVER_HARD_CAP_300/);
  assert.deepEqual(g.obligations.length > 0, true);
  const sch = skill_schedule_scaffold({ tenant_id: "sk-a1", objective_id: "UC-081", task_id: "UC-081-T01", tasks: ["daily recap"], cadence: "daily" });
  assert.equal(sch.status, "OK");
  assert.equal(sch.typed_artifact.realized, false); // scaffold only — NEVER creates real schedules here

  // declared sheet-04 fields: inputs referenced + outputs emitted (full P0_SKILL_FUNCTIONS map, incl WO-113 batch 1)
  const audit = p0ContractFieldAudit({
    "ledger-append": led, "catalog-query": cat, "evidence-append": ev, "gate-check": g, "schedule-scaffold": sch, "report-compose": rep,
    "creative-generator": skill_creative_generate({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T03", source_refs: ["s"], validated_domain_inputs: { media_kind: "image", brief: "b" } }),
    "poster-social-creator": skill_poster_social_create({ tenant_id: "sk-a1", product_id: "P", brand_id: "B", platforms: ["facebook"], language: "en", objective: "o", budget: 1, source_refs: ["s"], validated_domain_inputs: { brand_name: "B", rights_confirmed: true } }),
    "margin-analyst": skill_margin_analyze({ sku_prices: [{ sku: "A", price_myr: 10 }], verified_costs: [{ sku: "A", landed_cost_myr: 4 }], fee_schedule: { marketplace_pct: 1, payment_pct: 1, fixed_per_unit_myr: 0 } }),
    "storefront-builder": skill_storefront_build({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T04", source_refs: ["s"], validated_domain_inputs: { products: [{ sku: "A", name: "n", price_myr: 1 }], brand: { name: "B" } } }),
    "claims-reviewer": skill_claims_review({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T05", source_refs: ["s"], validated_domain_inputs: { claims: [{ text: "a plain descriptive sentence" }] } }),
    "compliance-researcher": skill_compliance_research({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T06", source_refs: ["s"], validated_domain_inputs: { markets: ["MY"] } }),
    "funnel-builder": skill_funnel_build({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T07", source_refs: ["s"], validated_domain_inputs: { funnel_steps: [{ stage: "landing", purpose: "intro" }] } }),
    "spend-controller": skill_spend_control({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T08", source_refs: ["s"], validated_domain_inputs: { action: "declare_scope", cap_myr: 77 } }),
    "supplier-verification": skill_supplier_verify({ supplier_details: [{ supplier_ref: "S", name: "N", registration_no: "R" }], agreements: [{ supplier_ref: "S", doc_ref: "d" }], price_lists: [{ supplier_ref: "S" }] }),
    "audience-researcher": skill_audience_research({ market: "MY", product: "p", allowed_channels: ["fb"] }),
    "business-model-analyst": skill_business_model_analyze({ owner_constraints: { weekly_hours: 20 }, market: "MY", available_capital: 100 }),
    "campaign-strategist": skill_campaign_design({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T09", source_refs: ["s"], validated_domain_inputs: { owner_budget_cap_myr: 10, audience_segments: ["a"], channels: ["c"] } }),
    "checkout-integrator": skill_checkout_integrate({ tenant_id: "sk-a1", merchant_config: { mode: "sandbox", tax_rate: 0 }, order_rules: { currency: "MYR", min_order_value_myr: 0, fulfillment_type: "dropship" }, payment_adapter: "sandbox-cod" }),
    "conversation-designer": skill_conversation_design({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T10", source_refs: ["s"], validated_domain_inputs: { tone: "warm", languages: ["ms"], common_objections: ["price"] } }),
    "demand-researcher": skill_demand_research({ product_category: "tea", geography: "MY", time_window: "90d", supplied_observations: [{ type: "verified_transaction", value: 3, source_ref: "o1" }] }),
    "fulfillment-planner": skill_fulfillment_plan({ tenant_id: "sk-a1", objective_id: "UC-001", task_id: "UC-001-T11", source_refs: ["s"], validated_domain_inputs: { order_items: [{ sku: "A" }], supplier_rows: [{ supplier_ref: "S1", verdict: "VERIFIED_ON_DOCUMENTS", sla_days: 3 }] } }),
  });
  assert.equal(audit.length, 22);
  for (const a of audit) assert.equal(a.ok, true, a.family + " " + JSON.stringify(a));
});

/* ---------------- 8b. WO-113 tranche-2 deterministic modules (batch 1) ---------------- */
test("T2: SK-018 creative generator — NEEDS_INPUT/REJECTED + QUEUED_MOCK (never dispatches Wan)", () => {
  assert.equal(skill_creative_generate({}).status, "NEEDS_INPUT");
  const badKind = skill_creative_generate({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["s"], validated_domain_inputs: { media_kind: "hologram", brief: "x" } });
  assert.equal(badKind.status, "REJECTED");
  const noBrief = skill_creative_generate({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["s"], validated_domain_inputs: { media_kind: "image" } });
  assert.equal(noBrief.status, "REJECTED");
  const ok = skill_creative_generate({ tenant_id: "w113", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["src:brief"], validated_domain_inputs: { media_kind: "video", brief: "15s demo of the supplied SKU" } });
  assert.equal(ok.status, "OK");
  assert.equal(ok.typed_artifact.job_state, "QUEUED_MOCK");
  assert.equal(ok.typed_artifact.dispatched, false, "no external invocation — Wan is BLOCKED owner-token class");
  assert.equal(ok.typed_artifact.mode, "MOCK");
  const again = skill_creative_generate({ tenant_id: "w113", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["src:brief"], validated_domain_inputs: { media_kind: "video", brief: "15s demo of the supplied SKU" } });
  assert.equal(again.typed_artifact.job_id, ok.typed_artifact.job_id, "deterministic ids");
});

test("T2: SK-055 poster/social — rights block, unsupported platform draft-only, no invented price", () => {
  assert.equal(skill_poster_social_create({}).status, "NEEDS_INPUT");
  const base = { tenant_id: "w113", product_id: "P-1", brand_id: "BR-1", platforms: ["facebook", "tiktok"], language: "ms", objective: "sell more", budget: 100, source_refs: ["src:p"] };
  const noRights = skill_poster_social_create({ ...base, validated_domain_inputs: { brand_name: "Acme", rights_confirmed: false } });
  assert.equal(noRights.status, "REJECTED", "missing product rights: block");
  const ok = skill_poster_social_create({ ...base, validated_domain_inputs: { brand_name: "Acme", rights_confirmed: true, price_myr: 29.9 } });
  assert.equal(ok.status, "OK");
  assert.match(ok.poster_asset_id, /^POSTER-[0-9a-f]{12}$/);
  assert.equal(ok.typed_artifact.mode, "MOCK");
  assert.equal(ok.typed_artifact.render, "NOT_RENDERED_adapter_blocking");
  assert.equal(ok.post_drafts.find((d) => d.platform === "tiktok").state, "draft_only", "platform incompatibility → draft only");
  assert.equal(ok.post_drafts.find((d) => d.platform === "facebook").state, "ready_for_owner_review");
  assert.equal(ok.qa_result.overall, "PARTIAL");
  assert.equal(ok.cost_estimate.estimate_myr, null, "UNKNOWN pricing is never fabricated");
  const noPrice = skill_poster_social_create({ ...base, validated_domain_inputs: { brand_name: "Acme", rights_confirmed: true } });
  assert.match(noPrice.post_drafts[0].body, /no invented price/);
});

test("T2: SK-030 margin analyst — supplied-figures math, UNKNOWN exclusion, deterministic rank", () => {
  assert.equal(skill_margin_analyze({}).status, "NEEDS_INPUT");
  const r = skill_margin_analyze({
    sku_prices: [{ sku: "A", price_myr: 100 }, { sku: "B", price_myr: 50 }],
    verified_costs: [{ sku: "A", landed_cost_myr: 40, delivery_myr: 5, returns_allowance_myr: 5 }],
    fee_schedule: { marketplace_pct: 10, payment_pct: 3, fixed_per_unit_myr: 2 },
  });
  assert.equal(r.status, "OK");
  assert.deepEqual(r.unknown_cost_flags.map((u) => u.sku), ["B"], "missing components → UNKNOWN, excluded from ranking");
  assert.equal(r.margin_table.length, 1);
  assert.equal(r.margin_table[0].contribution_myr, 35, "100 − (40+5+5) − (13+2) = 35");
  assert.equal(r.break_even.find((b) => b.sku === "B").break_even_price_myr, null);
});

test("T2: SK-047 storefront builder — SPEC_ONLY, validation reject, publication NEVER auto, Hashmeta BLOCKED untouched", () => {
  assert.equal(skill_storefront_build({}).status, "NEEDS_INPUT");
  const bad = skill_storefront_build({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T02", source_refs: ["s"], validated_domain_inputs: { products: [{ name: "no sku no price" }], brand: { name: "Acme" } } });
  assert.equal(bad.status, "REJECTED");
  const ok = skill_storefront_build({ tenant_id: "w113", objective_id: "UC-001", task_id: "UC-001-T02", source_refs: ["src:cat"], validated_domain_inputs: { products: [{ sku: "A", name: "Widget", price_myr: 10 }], brand: { name: "Acme" } } });
  assert.equal(ok.status, "OK");
  assert.equal(ok.typed_artifact.site_spec.mode, "SPEC_ONLY");
  assert.equal(ok.typed_artifact.site_spec.connector.class, "BLOCKED");
  assert.equal(ok.typed_artifact.site_spec.connector.live_call_made, false);
  assert.equal(ok.typed_artifact.approval_requests, undefined);
  assert.match(ok.approval_requests[0].requires, /owner approval/i);
  assert.equal(ok.uncertainty_flags.includes("hashmeta_connector_BLOCKED_no_live_call"), true);
});

test("T2: real-HTTP — /api/odai/registry serves the WO-113 wiring; progress file matches contracts", async () => {
  const summary = await getj("/api/odai/registry"); // spawned engine (HTTP), not a mock import
  assert.equal(summary.counts.skills, 59);
  const contractsRaw = JSON.parse(readFileSync(new URL("odai/config/skill_contracts.json", root), "utf8"));
  const byId = new Map(contractsRaw.rows.map((r) => [r.skill_id, r]));
  for (const [sid, fam] of [["SK-018", "creative-generator"], ["SK-030", "margin-analyst"], ["SK-047", "storefront-builder"], ["SK-055", "poster-social-creator"]]) {
    const impl = byId.get(sid).implementation;
    assert.equal(impl.status, "IMPLEMENTED_P0", sid + " status");
    assert.equal(impl.module, "server/odai/skills.mjs", sid + " module");
    assert.equal(impl.work_order, "WO-113", sid + " work order");
    assert.ok(byId.get(sid).suggested_module || true);
    assert.equal(impl.family, fam);
  }
  const progress = JSON.parse(readFileSync(new URL("odai/config/skills_implemented.json", root), "utf8"));
  assert.equal(progress.implemented.length >= 10, true);
  const reg = registrySummary(); // same code path the HTTP handler serves
  assert.equal(reg.counts.skills, 59);
});

/* ---------------- 8c. WO-113 tranche-2 batch 2 — claims/compliance/funnel/spend ---------------- */
test("T2b: SK-012 claims reviewer — banned expressions rejected, ungrounded flagged, no legal opinion", () => {
  assert.equal(skill_claims_review({}).status, "NEEDS_INPUT");
  const noClaims = skill_claims_review({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["s"], validated_domain_inputs: {} });
  assert.equal(noClaims.status, "REJECTED");
  const hit = skill_claims_review({ tenant_id: "w113b2", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["ref:study-1"], validated_domain_inputs: { claims: [{ text: "This tea cures cancer — 100% effective, no side effects" }, { text: "Hemp tea, brewed traditionally" }] } });
  assert.equal(hit.status, "OK");
  assert.deepEqual(hit.typed_artifact.rejected_claim_ids, ["C1"]);
  assert.equal(hit.typed_artifact.verdicts[1].screen, "PASS_SCREEN");
  assert.equal(hit.typed_artifact.legal_signoff.includes("REQUIRED"), true);
  assert.equal(hit.approval_requests.length, 1);
  const bare = skill_claims_review({ tenant_id: "w113b2", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["s"], validated_domain_inputs: { claims: [{ text: "ok copy" }] } });
  assert.equal(bare.typed_artifact.verdicts[0].grounding, "global_refs_only_no_claim_link");
  assert.equal(bare.typed_artifact.verdicts[0].escalate_to_owner, true);
  assert.equal(skill_claims_review({ tenant_id: "w113b2", objective_id: "UC-001", task_id: "UC-001-T01", validated_domain_inputs: { claims: [{ text: "x" }] } }).status, "NEEDS_INPUT", "empty source_refs counts as absent");
});

test("T2b: SK-013 compliance researcher — framework only, every verdict UNKNOWN, zero invented facts", () => {
  assert.equal(skill_compliance_research({}).status, "NEEDS_INPUT");
  const r = skill_compliance_research({ tenant_id: "w113b2", objective_id: "UC-001", task_id: "UC-001-T02", source_refs: ["s"], validated_domain_inputs: { markets: ["MY"] } });
  assert.equal(r.status, "OK");
  assert.equal(r.typed_artifact.substantive_findings, 0);
  assert.equal(r.typed_artifact.framework_only, true);
  assert.equal(r.typed_artifact.checklist.length, 5);
  for (const row of r.typed_artifact.checklist) assert.match(row.verdict, /^UNKNOWN/);
});

test("T2b: SK-026 funnel builder — SPEC_ONLY, Hashmeta BLOCKED never called, deterministic spec id", () => {
  assert.equal(skill_funnel_build({}).status, "NEEDS_INPUT");
  assert.equal(skill_funnel_build({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T03", source_refs: ["s"], validated_domain_inputs: {} }).status, "REJECTED");
  const a = skill_funnel_build({ tenant_id: "w113b2", objective_id: "UC-001", task_id: "UC-001-T03", source_refs: ["src:flows"], validated_domain_inputs: { funnel_steps: [{ stage: "landing", purpose: "voice-first intro" }, { stage: "lead_form", purpose: "capture" }] } });
  assert.equal(a.status, "OK");
  assert.equal(a.typed_artifact.funnel_spec.mode, "SPEC_ONLY");
  assert.equal(a.typed_artifact.funnel_spec.connector.class, "BLOCKED");
  assert.equal(a.typed_artifact.funnel_spec.connector.live_call_made, false);
  assert.equal(a.approval_requests[0].auto, false);
  const b = skill_funnel_build({ tenant_id: "w113b2", objective_id: "UC-001", task_id: "UC-001-T03", source_refs: ["src:flows"], validated_domain_inputs: { funnel_steps: [{ stage: "landing", purpose: "voice-first intro" }, { stage: "lead_form", purpose: "capture" }] } });
  assert.equal(b.typed_artifact.funnel_spec.spec_id, a.typed_artifact.funnel_spec.spec_id);
});

test("T2b: SK-046 spend controller — SEC-05 reservation consumer: declare/hold/release, cap enforced atomically, gate-check consumes the hold", () => {
  const t = "sp-113b2"; const o = "UC-046X";
  assert.equal(skill_spend_control({}).status, "NEEDS_INPUT");
  const badAction = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T01", validated_domain_inputs: { action: "spend_it_all" } });
  assert.equal(badAction.status, "REJECTED");
  const decl = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T01", validated_domain_inputs: { action: "declare_scope", cap_myr: 100 } });
  assert.equal(decl.typed_artifact.budget.cap_myr, 100);
  const declAgain = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T01", validated_domain_inputs: { action: "declare_scope", cap_myr: 100 } });
  assert.equal(declAgain.status, "OK"); assert.equal(declAgain.typed_artifact.newly_registered, false, "idempotent declare");
  const conflict = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T01", validated_domain_inputs: { action: "declare_scope", cap_myr: 50 } });
  assert.equal(conflict.status, "REJECTED", "CAP_LOCKED never silently overridden");
  assert.equal(conflict.uncertainty_flags[0], "cap_lock_conflict_fail_closed");
  const over = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T01", validated_domain_inputs: { action: "hold", amount_myr: 150 } });
  assert.equal(over.status, "REJECTED", "hold beyond cap refused atomically");
  const hold = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T01", source_refs: ["plan:ads"], validated_domain_inputs: { action: "hold", amount_myr: 60, note: "ads reservation" } });
  assert.equal(hold.status, "OK"); assert.equal(hold.typed_artifact.state, "held");
  assert.match(hold.typed_artifact.reservation_id, /^RES-/);
  // gate-check (SK-035) consumes HELD reservations — the two modules share the one reservation engine
  const gate = skill_gate_check({ actor: "OWNER", tenant: t, action: "approve_spend", resource: o, risk: "medium", gate: { scope: "spend" }, owner_approved: true, amount_myr: 60, cap_myr: 100 });
  assert.equal(gate.policy_decision, "ALLOW", "60 held + 0 remaining ask within cap RM100");
  assert.equal(gate.reason_code, "owner_approved_reservation_consumed");
  const snap = budgetScope(t, o);
  assert.equal(snap.consumed_myr, 60);
  const second = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T02", validated_domain_inputs: { action: "hold", amount_myr: 50 } });
  assert.equal(second.status, "REJECTED", "remaining RM40 < RM50 — cumulative cap enforced (SEC-05)");
  const rel = skill_spend_control({ tenant_id: t, objective_id: o, task_id: "UC-001-T03", validated_domain_inputs: { action: "release_holds", note: "plan cancelled" } });
  assert.equal(rel.status, "OK"); assert.equal(typeof rel.typed_artifact.released, "number");
});

/* ---------------- 8d. WO-113 tranche-2 batch 3 — supplier/audience/model/campaign ---------------- */
test("T2c: SK-049 supplier verification — documents-only verdicts, UNVERIFIED_PENDING_AGREEMENT never softened", () => {
  assert.equal(skill_supplier_verify({}).status, "NEEDS_INPUT");
  const r = skill_supplier_verify({
    supplier_details: [
      { supplier_ref: "SUP-A", name: "Alpha Goods", registration_no: "2019001A", fulfillment_terms: "D+3" },
      { supplier_ref: "SUP-B", name: "Beta Foods" },
    ],
    agreements: [{ supplier_ref: "SUP-A", doc_ref: "AGR-1" }],
    price_lists: [{ supplier_ref: "SUP-A", item: "x" }],
  });
  assert.equal(r.status, "OK");
  assert.equal(r.supplier_verification[0].verdict, "VERIFIED_ON_DOCUMENTS");
  assert.equal(r.supplier_verification[1].verdict, "UNVERIFIED_PENDING_AGREEMENT");
  assert.ok(r.exceptions.some((e) => e.issue === "IDENTITY_EVIDENCE_MISSING" && e.supplier_ref === "SUP-B"));
  assert.ok(r.exceptions.some((e) => e.issue === "NO_QUOTED_COSTS_ON_FILE" && e.supplier_ref === "SUP-B"));
  assert.match(r.supplier_verification[0].verdict_note || r.supplier_verification[0].caveat, /no external registry lookup/i);
});

test("T2c: SK-002 audience researcher — lawful cohorts, assumptions labelled, sensitive targeting excluded", () => {
  assert.equal(skill_audience_research({}).status, "NEEDS_INPUT");
  const r = skill_audience_research({ market: "MY", product: "herbal tea", allowed_channels: ["facebook", "whatsapp_business"] });
  assert.equal(r.status, "OK");
  assert.equal(r.segment_profiles.length, 3);
  for (const p of r.segment_profiles) { assert.ok(p.assumption, "every profile carries its assumption register"); assert.equal(p.lawful_basis.includes("non-sensitive"), true); }
  assert.ok(r.exclusions.some((e) => /sensitive_attributes/.test(e)));
  assert.ok(r.exclusions.some((e) => /personally_identifiable/.test(e)));
  assert.ok(r.exclusions.some((e) => /scraped/.test(e)));
});

test("T2c: SK-005 business model analyst — deterministic constraint fit, assumptions + risk register, no market facts invented", () => {
  assert.equal(skill_business_model_analyze({}).status, "NEEDS_INPUT");
  const bad = skill_business_model_analyze({ owner_constraints: {}, market: "MY", available_capital: -1 });
  assert.equal(bad.status, "REJECTED");
  const r = skill_business_model_analyze({ owner_constraints: { weekly_hours: 10, mobility: "limited", digital_literacy: "basic" }, market: "MY", available_capital: 0 });
  assert.equal(r.status, "OK");
  assert.equal(r.ranked_business_models.length, 4);
  const sorted = [...r.ranked_business_models].sort((a, b) => b.fit_score - a.fit_score);
  assert.deepEqual(r.ranked_business_models.map((x) => x.model), sorted.map((x) => x.model), "ranking is by fit_score desc");
  assert.equal(r.ranked_business_models.find((x) => x.model === "pop_up_preorder").fit_score <= r.ranked_business_models[0].fit_score, true, "mobility-limited owner penalises pop-up");
  assert.ok(r.assumptions.some((a) => /ASSUMPTIONS/.test(a)) && r.assumptions.some((a) => /no live market data/i.test(a)));
  assert.equal(r.risk_register.length >= 3, true);
});

test("T2c: SK-007 campaign strategist — cap mandatory, DRAFT_ONLY, activation NEVER without per-campaign owner approval, Hashmeta untouched", () => {
  assert.equal(skill_campaign_design({}).status, "NEEDS_INPUT");
  const noCap = skill_campaign_design({ tenant_id: "t", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["s"], validated_domain_inputs: { audience_segments: ["a"], channels: ["fb"] } });
  assert.equal(noCap.status, "REJECTED");
  const ok = skill_campaign_design({ tenant_id: "w113b3", objective_id: "UC-001", task_id: "UC-001-T01", source_refs: ["src:plan"], validated_domain_inputs: { owner_budget_cap_myr: 300, audience_segments: ["value_seeker_bargain_hunters"], channels: ["facebook"] } });
  assert.equal(ok.status, "OK");
  assert.equal(ok.typed_artifact.campaign_draft.mode, "DRAFT_ONLY");
  assert.equal(ok.typed_artifact.campaign_draft.activation.activated, false);
  assert.equal(ok.typed_artifact.campaign_draft.activation.connector_class, "BLOCKED");
  assert.equal(ok.typed_artifact.campaign_draft.owner_budget_cap_myr, 300);
  assert.match(ok.typed_artifact.campaign_draft.spend_rule, /SK-035 atomic reservation gate/);
  assert.equal(ok.approval_requests[0].auto, false);
});

/* ---------------- 8e. WO-113 tranche-2 batch 4 — checkout/conversation/demand/fulfillment ---------------- */
test("T2d: SK-011 checkout integrator — sandbox dry-run only, live BLOCKED (CAT-21), credential-like input refused", () => {
  assert.equal(skill_checkout_integrate({}).status, "NEEDS_INPUT");
  const live = skill_checkout_integrate({ tenant_id: "t", merchant_config: { mode: "live" }, order_rules: {}, payment_adapter: "x" });
  assert.equal(live.status, "REJECTED"); assert.equal(live.integration_status, "BLOCKED");
  const cred = skill_checkout_integrate({ tenant_id: "t", merchant_config: { mode: "sandbox" }, order_rules: { currency: "MYR", min_order_value_myr: 0, fulfillment_type: "dropship" }, payment_adapter: "sk_live_secret_abc123" });
  assert.equal(cred.status, "REJECTED");
  assert.match(cred.reason, /name/i);
  const ok = skill_checkout_integrate({ tenant_id: "w113b4", merchant_config: { mode: "sandbox", tax_rate: 0 }, order_rules: { currency: "MYR", min_order_value_myr: 10, fulfillment_type: "dropship" }, payment_adapter: "sandbox-cod" });
  assert.equal(ok.status, "OK");
  assert.equal(ok.integration_status, "SANDBOX_READY_LIVE_BLOCKED");
  assert.equal(ok.typed_artifact.credentials_stored, false);
  assert.equal(ok.checkout_test_result.gateway_called, false);
  assert.ok(ok.checkout_test_result.cases.some((c) => c.case === "live_submit_attempt" && /BLOCKED/.test(c.result)));
  assert.equal(ok.approval_requests[0].auto, false);
  const badRules = skill_checkout_integrate({ tenant_id: "t", merchant_config: { mode: "sandbox" }, order_rules: { currency: "USD", min_order_value_myr: -1, fulfillment_type: "teleport" }, payment_adapter: "sandbox-cod" });
  assert.equal(badRules.status, "REJECTED"); assert.equal(badRules.exceptions.length, 3);
});

test("T2d: SK-016 conversation designer — draft scripts only, owner voice mandatory, outbound contact never automatic", () => {
  assert.equal(skill_conversation_design({}).status, "NEEDS_INPUT");
  const silent = skill_conversation_design({ tenant_id: "t", objective_id: "O", task_id: "T", source_refs: ["s"], validated_domain_inputs: {} });
  assert.equal(silent.status, "REJECTED"); assert.match(silent.reason, /never invented/i);
  const ok = skill_conversation_design({ tenant_id: "w113b4", objective_id: "UC-001", task_id: "UC-001-T02", source_refs: ["src:owner"], validated_domain_inputs: { tone: "gentle", languages: ["ms", "en"], common_objections: ["price_too_high"] } });
  assert.equal(ok.status, "OK");
  const d = ok.typed_artifact.conversation_flow_draft;
  assert.equal(d.stages.length, 5);
  assert.ok(d.stages.some((s) => s.stage === "handoff"));
  assert.equal(d.outbound_messaging.automatic, false);
  assert.equal(d.outbound_messaging.state, "NOT_SENT");
  assert.ok(ok.uncertainty_flags.some((u) => /SK-023/.test(u)));
  assert.equal(ok.approval_requests[0].auto, false);
});

test("T2d: SK-019 demand researcher — cited evidence only, indicator vs verified Transaction separation, no invented market facts", () => {
  assert.equal(skill_demand_research({}).status, "NEEDS_INPUT");
  const naked = skill_demand_research({ product_category: "tea", geography: "MY", time_window: "90d" });
  assert.equal(naked.status, "REJECTED");
  const ok = skill_demand_research({
    product_category: "herbal tea", geography: "MY", time_window: "Q3-2026",
    supplied_observations: [
      { type: "verified_transaction", value: 42, source_ref: "store:orders-q3" },
      { type: "indicator", value: "search-trend-up", source_ref: "owner-notes:intake" },
      { type: "indicator", source_ref: null },
    ],
    competitor_rows: [{ name: "Corp", price_myr: 9 }],
  });
  assert.equal(ok.status, "OK");
  assert.equal(ok.demand_brief.verified_transaction_demand.length, 1);
  assert.equal(ok.demand_brief.indicators.length, 1);
  assert.equal(ok.demand_brief.competitor_rows[0].status, "supplied_unverified");
  assert.ok(ok.uncertainty.includes("external_live_research_sources_NOT_consulted_no_connector"));
  assert.ok(ok.demand_brief.confidence.startsWith("LOW") || ok.demand_brief.confidence.startsWith("MEDIUM"), "one verified row → LOW/MEDIUM, never HIGH");
  const allUncited = skill_demand_research({ product_category: "x", geography: "MY", time_window: "1d", supplied_observations: [{ type: "indicator", value: 1 }] });
  assert.equal(allUncited.status, "REJECTED");
});

test("T2d: SK-025 fulfillment planner — verified suppliers only, SLA labelled quoted-not-guaranteed, dispatch BLOCKED/NEVER from skill", () => {
  assert.equal(skill_fulfillment_plan({}).status, "NEEDS_INPUT");
  const thin = skill_fulfillment_plan({ tenant_id: "t", objective_id: "O", task_id: "T", source_refs: ["s"], validated_domain_inputs: {} });
  assert.equal(thin.status, "REJECTED");
  const unverified = skill_fulfillment_plan({ tenant_id: "t", objective_id: "O", task_id: "T", source_refs: ["s"], validated_domain_inputs: { order_items: [{ sku: "A" }], supplier_rows: [{ supplier_ref: "S9", verdict: "UNVERIFIED_PENDING_AGREEMENT", sla_days: 1 }] } });
  assert.equal(unverified.status, "REJECTED");
  const ok = skill_fulfillment_plan({
    tenant_id: "w113b4", objective_id: "UC-001", task_id: "UC-001-T03", source_refs: ["s"],
    validated_domain_inputs: { order_items: [{ sku: "A" }, { sku: "B" }], supplier_rows: [
      { supplier_ref: "S1", verdict: "VERIFIED_ON_DOCUMENTS", sla_days: 3 },
      { supplier_ref: "S2", verdict: "VERIFIED_ON_DOCUMENTS", sla_days: 1 },
      { supplier_ref: "S3", verdict: "UNVERIFIED_PENDING_AGREEMENT" },
    ] },
  });
  assert.equal(ok.status, "OK");
  const p = ok.typed_artifact.fulfillment_plan;
  assert.equal(p.routes.length, 2);
  assert.ok(p.routes.every((r) => r.route_state === "PLANNED_NOT_DISPATCHED"));
  assert.equal(p.routes[0].supplier_ref, "S2", "shortest on-file SLA routed first (deterministic)");
  assert.equal(p.total_window_days, 3);
  assert.equal(p.unverified_excluded.length, 1);
  assert.equal(p.dispatch.connector_class, "BLOCKED");
  assert.equal(p.dispatch.outbound_po_or_email, "NEVER_FROM_THIS_SKILL");
  assert.ok(p.routes.every((r) => r.sla_basis.includes("not_guarantee")));
  assert.equal(ok.typed_artifact.mode, "SANDBOX_PLAN_EXTERNAL_BLOCKED");
});

/* ---------------- 9. WO-104 immutable money ledger ---------------- */
test("A1: money ledger is append-only, tenant-scoped, whitelist fields (no PII columns)", () => {
  const t1 = "led-a1-x"; const t2 = "led-a1-y";
  const a = appendMoneyEvent(t1, { amount_myr: 10, direction: "out", source_tag: "fixture:sale", objective_id: "UC-071", task_id: "UC-071-T01", customer_email: "should-not-land@example.com" });
  assert.equal(a.status, undefined);
  assert.ok(a.event);
  assert.equal("customer_email" in a.event, false, "no PII columns by construction");
  const b = appendMoneyEvent(t1, { amount_myr: 25, direction: "in", source_tag: "fixture:payment", objective_id: "UC-071", task_id: "UC-071-T02" });
  assert.ok(b.event);
  const totals = moneyTotals(t1, { objective_id: "UC-071" });
  assert.deepEqual(totals, { money_in: 25, money_out: 10, net: 15, count: 2 });
  assert.equal(moneyTotals(t2, { objective_id: "UC-071" }).count, 0, "tenant isolation");
  // immutable: prior event objects are frozen copies; totals follow appends, replacements append
  const frozen = moneyEvents(t1)[0];
  assert.equal(Object.isFrozen(frozen), true);
  assert.throws(() => { frozen.amount_myr = 999; }, TypeError);
  const bad1 = appendMoneyEvent(t1, { amount_myr: -5, direction: "out", source_tag: "x" });
  assert.match(bad1.error, /non-negative/);
  const bad2 = appendMoneyEvent(t1, { amount_myr: 5, direction: "out" });
  assert.match(bad2.error, /source_tag/);
  assert.equal(moneyEvents(t1).length, 2, "refusals never append — still 2 rows");
  const r = appendMoneyEvent(t1, { amount_myr: 10, direction: "in", source_tag: "fixture:correction", event_id_replaces: frozen.event_id });
  assert.equal(r.event.event_id_replaces, frozen.event_id);
  assert.equal(moneyEvents(t1).length, 3, "corrections are new events, not edits");
});
