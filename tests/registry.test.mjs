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
import { skill_ledger_append, skill_catalog_query, skill_evidence_append, skill_gate_check, skill_schedule_scaffold, skill_report_compose, p0ContractFieldAudit } from "../server/odai/skills.mjs";
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
  assert.equal(t1.blocked_reason, "SKILL_NOT_IMPLEMENTED");
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

  // declared sheet-04 fields: inputs referenced + outputs emitted
  const audit = p0ContractFieldAudit({
    "ledger-append": led, "catalog-query": cat, "evidence-append": ev, "gate-check": g, "schedule-scaffold": sch, "report-compose": rep,
  });
  for (const a of audit) assert.equal(a.ok, true, a.family + " " + JSON.stringify(a));
});

/* ---------------- 8. WO-104 immutable money ledger ---------------- */
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
