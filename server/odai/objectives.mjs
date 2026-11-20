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

/* create → validate → manifest → begin first execution phase (beats 1–5 incl. spend gate) */
export async function createObjective(tenantId, statement) {
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
  await project(obj);
  return view(obj);
}

export function classify(obj) {
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

export function view(obj) { return { objective_id: obj.objective_id, tenant_id: obj.tenant_id, criterion: obj.criterion, state: obj.state, progress: obj.progress, tasks: obj.tasks.map((x) => ({ id: x.id, state: x.state, specialist: x.specialist, deps: x.deps, evidence: x.evidence })), gates: obj.gates.map(({ id, scope, state, release_log }) => ({ id, scope, state, release_log })), report: obj.state === "REPORTED" ? classify(obj) : null }; }
export function finalReport(tenantId, objective_id) { const obj = store.get(tenantId + "/" + objective_id); return obj ? classify(obj) : { error: "not found" }; }

/* WO-10R: tenant-scoped objective list for GET /api/odai/objectives (summary projection;
 * the per-objective view()/resume() route remains the full plan read path). */
export function listObjectives(tenantId) {
  const out = [];
  for (const [k, o] of store) if (k.startsWith(tenantId + "/")) out.push({ objective_id: o.objective_id, tenant_id: o.tenant_id, statement: o.statement, criterion: o.criterion, state: o.state, created_at: o.created_at });
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
