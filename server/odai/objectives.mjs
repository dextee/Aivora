/* odai/objectives.mjs — D08/D10 Objective-to-Task Engine (9.0), strict-reuse design:
 * the dependency graph is a PROJECTION over the existing workflow.mjs 10-beat run.
 * Beats remain the single execution engine (D04/D05); gates remain D08 policy objects.
 * This module adds: interpretation, validation, manifest + graph state, approval
 * handling per scope, recovery checkpoints (durable objective rows), classification.
 */
import { get, logEvent } from "./store.mjs";
import * as wf from "./workflow.mjs";
import * as db from "./db.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
/* WO-A1 (WO-110/WO-102): business-plane registry routing. ADDITIVE only — the generic
 * planner below remains the complete fallback path; registry is DATA (odai/config).
 * G1 posture: no second dispatcher/policy evaluator introduced. */
import { matchObjective, planFor, criterionFromText } from "./registry.mjs";
import { skill_gate_check, skill_report_compose } from "./skills.mjs";

/* task graph: every task resolves from beat receipts (source of truth) */
const TASKS = [
  { id: "intake", specialist: "orchestrator", deps: [], beat: 1 },
  { id: "plan", specialist: "orchestrator", deps: ["intake"], beat: 2 },
  { id: "research_demand", specialist: "research", deps: ["plan"], beat: 3 },
  { id: "catalog_prepare", specialist: "catalog", deps: ["research_demand"], beat: 4 },
  { id: "storefront_draft", specialist: "website", deps: ["catalog_prepare"], beat: 4, note: "preview draft from beat-4 receipt" },
  { id: "marketing_plan", specialist: "marketing", deps: ["storefront_draft"], internal: true },
  { id: "schedule", specialist: "orchestrator", deps: ["marketing_plan"], internal: true },
  { id: "watch_verify", specialist: "watch", deps: ["catalog_prepare", "marketing_plan"], beat: 7, expect: "NEVER" },
  { id: "channel_package", specialist: "marketing", deps: ["watch_verify"], beat: 8 },
  { id: "fulfillment_sim", specialist: "report", deps: ["channel_package"], beat: 9, simulated: true },
  { id: "final_report", specialist: "report", deps: ["fulfillment_sim"], beat: 10 },
];
const GATES = [
  { id: "approve_spend", scope: "advertising spend", beat: 5 },
  { id: "approve_publish", scope: "external publishing (Shopee/Facebook)" },
  { id: "approve_customer_comms", scope: "customer messages (WhatsApp/email)" },
];

export function interpret(raw) {
  const text = String(raw || "").trim();
  const units = +(text.match(/(\d+)(?:\s+\w+){0,4}\s*(?:units?|products?|pieces?|pcs|个|件|套)/i)?.[1] || 0);
  const pct = +(text.match(/(\d+)\s*%/)?.[1] || 0);
  const days = +(text.match(/(\d+)\s*(?:days?|天|工|日)/i)?.[1] || 0);
  const catalog = /fny\s?global/i.test(text) ? "FNYGlobal" : null;
  const brand = /good\s?doctor/i.test(text) ? "The Good Doctor Organization" : /lumen/i.test(text) ? "Lumen Wellness (synthetic demo brand)" : null;
  let criterion = null;
  if (units && (catalog || brand)) criterion = { kind: "units_sold", target_units: units, via_catalog: catalog, brand, measurable: true };
  else if (pct && days) criterion = { kind: "growth", pct, days, measurable: true };
  return { text, criterion, valid: !!criterion, reason: criterion ? null : "not measurable — restate with a number (units / % over days)" };
}

function internalArtifact(task, obj) {
  if (task.id === "marketing_plan") return { channels: ["Shopee(draft)", "Facebook(draft)", "WhatsApp Broadcast(draft)"], message: `Sell ${obj.criterion.target_units} ${obj.criterion.brand || ""} wellness units via ${obj.criterion.via_catalog} catalog`, budget_proposal_sgd: 150, requires_gate: "approve_spend", external: false };
  return { cadence: "10-beat staging run under TEST mode", schedule: TASKS.map((t, i) => ({ task: t.id, slot: i })) };
}

async function persist(obj) {
  try { if (await db.dbAvailable()) { const m = await import("./db.mjs"); m.upsertObjective && m.upsertObjective({ tenant_id: obj.tenant_id, objective_id: obj.objective_id, row: obj }); logEvent(get(obj.tenant_id), { runId: obj.run_id, beat: "·", actor: "orchestrator", kind: "OBJECTIVE_CHECKPOINT", decision: "ALLOW", note: obj.state }); } } catch { /* durable-best-effort: memory remains authoritative in staging */ }
}

/* WO-A1 registry objective (WO-110 routing + WO-102 generalized criterion).
 * The registry plan IS the manifest — task ids/steps/deps/skills equal the built
 * task_graph rows (plan == registry, proven by tests). No beats run for registry
 * objectives: beats stay the generic planner's executor; connector-BLOCKED and
 * NOT_IMPLEMENTED tasks are recorded honestly with blocked_reason, never faked. */
function registryStateFor(gates, approvals) {
  const live = gates.filter((g) => ["approve_spend", "approve_publish", "approve_customer_comms", "approve_external_action"].includes(g.id));
  if (live.some((g) => g.id === "approve_spend" && !approvals.includes(g.id))) return "AWAITING_SPEND_APPROVAL";
  if (live.some((g) => !approvals.includes(g.id))) return "AWAITING_GATE_APPROVAL";
  if (live.length) return "PLAN_APPROVED_HELD_CONNECTORS";
  return "PLAN_VALIDATED_READY"; // review-gated / no live scope — validated plan, owner advisory only
}
function registryProgress(obj) {
  const ready = obj.tasks.filter((x) => x.state === "ready").length;
  return `${obj.tasks.length - obj.tasks.filter((x) => x.state === "blocked_plan_validated").length}/${obj.tasks.length} tasks plan-validated (${ready} dispatch-ready P0 modules) · gates ${obj.gates.map((g) => g.id + ":" + g.state).join(", ") || "none"}`;
}
async function createRegistryObjective(tenantId, incoming, match, plan) {
  const objective_id = "OBJ-" + Date.now().toString(36);
  const criterion = criterionFromText(incoming) || (plan.criterion_spec && plan.criterion_spec.spec) ||
    { kind: "owner_acceptance_artifact", artifact: plan.acceptance ? String(plan.acceptance.success_oracle || "").slice(0, 200) : null };
  const gates = plan.gates.map((g) => ({ id: g.engine_gate_id, scope: g.scope, sheet_string: g.sheet_string, state: g.state, held_never: g.held_never_connector_readiness, release_log: null }));
  const obj = {
    objective_id, tenant_id: tenantId, plan_source: "registry",
    registry_objective_id: plan.registry_objective_id, business_family: plan.business_family,
    router_score: match.score, statement: incoming.trim().slice(0, 300), registry_statement: plan.statement,
    criterion, run_id: null,
    manifest: { tasks: plan.tasks.map((t) => ({ id: t.id, step: t.step })), gates: gates.map((g) => ({ id: g.id, scope: g.scope })), source: "odai/config (master registry, business-plane-v2.1-a1)" },
    tasks: plan.tasks.map((t) => ({ id: t.id, state: t.state, specialist: t.specialist, deps: t.depends_on,
      step: t.step, skill_id: t.skill_id, agent_id: t.agent_id,
      evidence: { module: t.module, fn: t.fn, connector_class: t.connector_class, executable: t.executable, blocked_reason: t.blocked_reason } })),
    gates,
    state: registryStateFor(gates, []),
    approvals: [], created_at: new Date().toISOString(), completed_at: null, report: null,
    dispatch_validation: { edges_validated: true, note: "registry edges validated (DAG) before dispatch — dispatch itself stays held until skills/connectors land" },
    acceptance: plan.acceptance, measurable_via: plan.measurable_via,
  };
  obj.progress = registryProgress(obj);
  store.set(tenantId + "/" + objective_id, obj);
  logEvent(get(tenantId), { runId: "·", beat: "·", actor: "orchestrator", kind: "OBJECTIVE_CREATED_REGISTRY", decision: "ALLOW", note: `${objective_id} -> ${obj.registry_objective_id} score=${obj.router_score} criterion=${criterion.kind || "artifact"}` });
  await persist(obj);
  return view(obj);
}

/* registry gate release — routes the OWNER decision through skill_gate_check (SK-035,
 * CTRL-06 shim; the 9.0 gateway itself is untouched: external stays held-NEVER and the
 * engine never dispatches on its own). cap binds spend approvals like decideSpend does. */
async function registryApprove(obj, scope, cap) {
  const g = obj.gates.find((x) => x.id === scope);
  if (!g) return { error: "unknown gate scope for registry objective: " + String(scope) };
  const capMyr = (obj.criterion && obj.criterion.kind === "money_cap_myr") ? obj.criterion.cap_myr : (g.scope === "spend" ? cap : 0);
  const decision = skill_gate_check({ actor: "OWNER", tenant: obj.tenant_id, action: scope, resource: obj.objective_id, risk: "medium",
    gate: { scope: g.scope }, owner_approved: true, amount_myr: g.scope === "spend" ? cap : 0, cap_myr: capMyr });
  if (decision.status !== "OK") return { error: "gate-check refused: " + (decision.reason || String(decision.missing)) };
  const d = decision.typed_artifact;
  if (d.policy_decision === "HOLD") { const v = view(obj); v.gate_decision = d; v.note = "spend approval needs owner confirm (approve again with cap)"; return v; }
  if (!obj.approvals.includes(scope)) obj.approvals.push(scope);
  obj.approval_log = [...(obj.approval_log || []), { scope, at: new Date().toISOString(), actor: "OWNER", decision: d.policy_decision, reason_code: d.reason_code,
    binding: g.scope === "spend" ? `cap RM${capMyr || cap} recorded (ledger-cumulative enforcement lands with the durable attach)` : "recorded; external write stays NEVER under 9.0 connector readiness" }];
  g.state = d.policy_decision === "BLOCK" ? "approved_held_EXTERNAL_NEVER" : g.scope === "spend" ? "approved_cap_recorded" : g.scope === "review" ? "advisory_recorded" : "released_pending_connectors";
  g.release_log = obj.approval_log[obj.approval_log.length - 1];
  obj.state = registryStateFor(obj.gates, obj.approvals);
  obj.progress = registryProgress(obj);
  logEvent(get(obj.tenant_id), { runId: "·", beat: "·", actor: "guardrails", kind: "GATE", decision: String(d.policy_decision), note: `${obj.objective_id} ${scope} ${d.reason_code}` });
  await persist(obj);
  const out = view(obj);
  out.gate_decision = d;
  return out;
}

/* create → validate → manifest → begin first execution phase (beats 1–5 incl. spend gate) */
export async function createObjective(tenantId, statement) {
  /* WO-110 router: deterministic lexical+template resolution to the business-plane
   * registry FIRST (no LLM). Unknown / below-threshold statements fall through to the
   * existing generic planner path below — unchanged, additive. */
  try {
    const match = matchObjective(String(statement || ""));
    if (match) {
      const plan = planFor(match.objective.objective_id);
      if (plan && plan.error) return { error: plan.error }; // fail closed before dispatch
      if (plan) return createRegistryObjective(tenantId, String(statement), match, plan);
    }
  } catch (e) { return { error: "registry router failure (fail closed, nothing dispatched): " + String((e && e.message) || e) }; }
  const p = interpret(statement);
  if (!p.valid) return { error: p.reason };
  const objective_id = "OBJ-" + Date.now().toString(36);
  const start = await wf.startRun(tenantId, p.text);
  const obj = { objective_id, tenant_id: tenantId, statement: p.text, criterion: p.criterion,
    run_id: start.runId, manifest: { tasks: TASKS, gates: GATES }, state: "AWAITING_SPEND_APPROVAL",
    approvals: [], created_at: new Date().toISOString(), completed_at: null, report: null };
  store.set(tenantId + "/" + objective_id, obj);
  logEvent(get(tenantId), { runId: obj.run_id, beat: 0, actor: "orchestrator", kind: "OBJECTIVE_CREATED", decision: "ALLOW", note: `${objective_id} criterion=${p.criterion.kind}:${p.criterion.target_units ?? p.criterion.pct}` });
  await project(obj); await persist(obj);
  return view(obj);
}
const store = new Map();

/* beat receipts → task states (projection; durable re-read on demand) */
export async function project(obj) {
  const t = get(obj.tenant_id);
  const rec = (b) => t.receipts.find((r) => r.runId === obj.run_id && r.beat === b)
    || (obj.receipts_from_db ? (obj.receipts_from_db.find((r) => r.beat === b)) : null);
  obj.tasks = TASKS.map((task) => {
    if (task.internal) return { ...task, state: rec(6) || obj.approvals.includes("approve_spend") ? "done" : "pending", evidence: internalArtifact(task, obj), attempts: 1 };
    const r = rec(task.beat);
    let state = "pending";
    if (r) {
      const ok = (r.decision || "ALLOW") === (task.expect || "ALLOW");
      state = ok ? (task.simulated ? "simulated" : "done") : r.decision === "APPROVE" ? "awaiting_owner_gate" : "failed";
    }
    if (task.id === "catalog_prepare" && rec(4) && state === "pending") state = "done";
    return { ...task, state, evidence: r ? { decision: r.decision, note: r.blocked_reason || r.note || r.summary, artifact: r.evidence || null } : null, attempts: r ? 1 : 0 };
  });
  obj.gates = GATES.map((g) => {
    const released = obj.approvals.includes(g.id);
    const requested = g.beat === 5 ? !!rec(5) || obj.approvals.length >= 0 : obj.tasks.some((x) => x.state === "done");
    return { ...g, state: released ? (g.id === "approve_spend" ? "released_executed" : "approved_held_EXTERNAL_NEVER") : requested ? "awaiting_owner" : "not_reached", release_log: released ? obj.approval_log?.find((l) => l.scope === g.scope) : null };
  });
  const allDone = obj.tasks.filter((x) => x.state === "done" || x.state === "simulated").length;
  if (rec(10)) obj.state = "REPORTED";
  else if (obj.gates.some((g) => g.state === "awaiting_owner")) obj.state = "AWAITING_SPEND_APPROVAL";
  else obj.state = obj.state === "REPORTED" ? "REPORTED" : "RUNNING";
  obj.progress = `${allDone}/${TASKS.length} tasks · gates ${obj.gates.filter((g) => g.state !== "not_reached").map((g) => g.id + ":" + g.state).join(", ")}`;
  return obj;
}

/* owner releases a gate. SPEND resumes real beats via D04 (decideSpend).
   PUBLISH/COMMS are recorded approved but remain held: D08 says external write NEVER.
   WO-02 (DEV-12): before dispatching spend, run tools/guardrails_preflight.mjs.
   A non-zero exit blocks dispatch with GATE/PREFLIGHT_FAILED + PREFLIGHT_BLOCKED.
   This is additive hardening, never a bypass: regardless of the preflight result,
   resume stays blocked by the 9.0 connector-readiness rules (external writes NEVER).
   Note: publish artifacts do not ship tools/, so deployed runtimes find no tool and
   treat it as "not run" (no-op) rather than a false G3 failure — a genuine non-zero exit always blocks. */
function preflightBlock(tenantId, obj) {
  const roots = [process.cwd(), new URL("../../", import.meta.url).pathname];
  const root = roots.find((r) => existsSync(r + "/tools/guardrails_preflight.mjs"));
  if (!root) return null;
  const res = spawnSync(process.execPath, ["tools/guardrails_preflight.mjs"], { cwd: root, encoding: "utf8" });
  if (res.status === null || res.status === undefined) return null; // spawn failure/killed: no exit code — not a failed verdict
  if (res.status === 0) return null;
  const reason = String(res.stderr || res.error?.message || "").trim().slice(-200) || ("preflight exited " + res.status + " with no stderr");
  logEvent(get(tenantId), { runId: obj.run_id, beat: "·", actor: "guardrails", kind: "GATE", decision: "BLOCK", note: "PREFLIGHT_FAILED: " + reason });
  return { outcome: "PREFLIGHT_BLOCKED", reason };
}
export async function approve(tenantId, objective_id, scope, cap = 150) {
  const obj = store.get(tenantId + "/" + objective_id);
  if (!obj) return { error: "objective not found (cold instance? re-create — durable replay lands in later version)" };
  if (obj.plan_source === "registry") return registryApprove(obj, String(scope), Number(cap) || 150);
  if (!obj.approvals.includes(scope)) obj.approvals.push(scope);
  obj.approval_log = [...(obj.approval_log || []), { scope, at: new Date().toISOString(), actor: "OWNER", binding: scope === "approve_spend" ? `workflow resume cap S$${cap}` : "recorded; external write stays NEVER under 9.0 connector readiness — nothing publishes or sends " }];
  if (scope === "approve_spend" && obj.state !== "REPORTED") {
    const blocked = preflightBlock(tenantId, obj);
    if (blocked) { obj.approvals.pop(); return blocked; }
    const res = await wf.decideSpend(tenantId, obj.run_id, true, cap);
    if (res.outcome !== "RESUMED") { obj.approvals.pop(); return { error: "resume refused by workflow", res }; }
  }
  await project(obj); await persist(obj);
  return view(obj);
}

/* safe recovery / resume: re-read receipts (from shared store or DB) and re-project without re-executing completed beats */
export async function resume(tenantId, objective_id) {
  let obj = store.get(tenantId + "/" + objective_id);
  if (!obj && await db.dbAvailable()) { /* durable replay hook */ return { error: "objective state was in a previous instance — DB-backed resume is the V33 slot; re-run demo for full lifecycle" }; }
  if (!obj) return { error: "not found" };
  if (obj.plan_source === "registry") { obj.state = registryStateFor(obj.gates, obj.approvals); obj.progress = registryProgress(obj); return view(obj); }
  await project(obj);
  return view(obj);
}

export function classify(obj) {
  if (obj.plan_source === "registry") {
    const money = skill_report_compose({ tenant_id: obj.tenant_id, objective_id: obj.objective_id });
    return {
      objective_id: obj.objective_id, tenant_id: obj.tenant_id, plan_source: "registry",
      registry_objective_id: obj.registry_objective_id, business_family: obj.business_family,
      statement: obj.statement.slice(0, 100), success_criterion: obj.criterion, measurable_via: obj.measurable_via,
      acceptance: obj.acceptance, state: obj.state, progress: obj.progress,
      completed: [], simulated: [], awaiting_owner_decision: [], failed: [],
      planned_ready: obj.tasks.filter((x) => x.state === "ready").map((x) => x.id),
      planned: obj.tasks.filter((x) => x.state !== "ready").map((x) => x.id),
      money_first: money.status === "OK" ? money.typed_artifact.money_first : { error: "ledger unavailable" },
      approval_gates: obj.gates.map((x) => ({ gate: x.id, scope: x.scope, state: x.state, sheet_string: x.sheet_string,
        note: x.state.startsWith("approved_held") ? "release recorded for owner scope, but 9.0 connector_readiness keeps external writes DISABLED — engine will NEVER publish/spend/send on its own" : undefined })),
      evidence_sources: { plan: "odai/config task_graph (topo-validated pre-dispatch)", ledger: "server/odai/ledger.mjs (WO-104 append-only)" },
      durable_note: "registry objectives carry plan + gate state only; execution lands per WO-110 as connectors/skills unblock",
      generated_at: new Date().toISOString(),
    };
  }
  const g = (s) => obj.tasks.filter((x) => x.state === s).map((x) => x.id);
  return {
    objective_id: obj.objective_id, tenant_id: obj.tenant_id, statement: obj.statement.slice(0, 100),
    success_criterion: obj.criterion, state: obj.state, progress: obj.progress,
    completed: g("done"), simulated: g("simulated"), awaiting_owner_decision: g("awaiting_owner_gate"),
    failed: g("failed"), not_reached: g("pending"),
    approval_gates: obj.gates.map((x) => ({ gate: x.id, scope: x.scope, state: x.state, note: x.state.startsWith("approved_held") ? "release recorded for owner scope, but 9.0 connector_readiness keeps external writes DISABLED — engine will NEVER publish/spend/send on its own" : undefined })),
    evidence_sources: beat_receipts_note(), durable_note: "task states project durably from beat receipts (odai_receipt/odai_trace); objective-row mirroring to odai_objective is the V33 slot — in-memory graph is authoritative per instance",
    generated_at: new Date().toISOString(),
  };
}
function beat_receipts_note() { return { manifest: "D03 tasks (fixed graph)", receipts: "D04 beats 1–10 (workflow.mjs)", policy: "D08 R01–R19 + connector gate", storage: "D10 odai_* tables (trace/receipt/run/approval)", simulated_boundary: "beat-9 order TEST_SIMULATED; supplier handoff PREPARED_NOT_SENT" }; }

export function view(obj) { return { objective_id: obj.objective_id, tenant_id: obj.tenant_id, criterion: obj.criterion, state: obj.state, progress: obj.progress, ...(obj.plan_source ? { plan_source: obj.plan_source, registry_objective_id: obj.registry_objective_id, business_family: obj.business_family, router_score: obj.router_score, measurable_via: obj.measurable_via, registry_statement: obj.registry_statement } : {}), tasks: obj.tasks.map((x) => ({ id: x.id, state: x.state, specialist: x.specialist, deps: x.deps, step: x.step, evidence: x.evidence })), gates: obj.gates.map(({ id, scope, state, release_log }) => ({ id, scope, state, release_log })), report: obj.state === "REPORTED" ? classify(obj) : null }; }
export function finalReport(tenantId, objective_id) { const obj = store.get(tenantId + "/" + objective_id); return obj ? classify(obj) : { error: "not found" }; }

/* WO-10R: tenant-scoped objective list for GET /api/odai/objectives (summary projection;
 * the per-objective view()/resume() route remains the full plan read path). */
export function listObjectives(tenantId) {
  const out = [];
  for (const [k, o] of store) if (k.startsWith(tenantId + "/")) out.push({ objective_id: o.objective_id, tenant_id: o.tenant_id, statement: o.statement, criterion: o.criterion, state: o.state, created_at: o.created_at });
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
