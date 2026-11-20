/* odai/workflow.mjs — the canonical 10-beat demo, one shared backend, three projections.
 * Dispatch invariant: every external-effect step passes M08 policy BEFORE any side
 * effect; BLOCK > HOLD > ALLOW; receipts carry evidence. demo_mode = TEST everywhere.
 * Persistence (increment 3): best-effort mirror writes to the page database; reads
 * prefer the database and fall back to the in-memory store. DB never blocks the demo.
 */
import { get, logEvent, profitSnapshot, DEMO_TENANT, COMPANY } from "./store.mjs";
import { evaluate, POLICY_VERSION } from "./policy.mjs";
import * as db from "./db.mjs";

export const SPECIALISTS = ["research", "catalog", "website", "marketing", "watch", "report"];

const BEAT_LABELS = {
  1: ["voice_objective", "orchestrator", "Goal received via voice (transcript is the authoritative record)"],
  2: ["qwenwork_orchestration", "orchestrator", "TaskManifest → six specialist subtasks assigned"],
  3: ["product_research", "research", "Wellness-category demand research (public sources, labelled)"],
  4: ["catalog_hashmeta_preview", "catalog+website", "Tenant catalog review + Hashmeta-style website DRAFT"],
  5: ["spending_approval", "human-gate", "Marketing spend requires explicit owner approval"],
  6: ["marketing_assets", "marketing", "Draft post/caption/creative pack — DRAFTS ONLY"],
  7: ["watch_invalid_data", "watch", "Injected invalid product data → BLOCKED before publish"],
  8: ["channel_drafts", "marketing", "Shopee/WhatsApp/email channel DRAFTS (never submitted)"],
  9: ["test_order_dropship", "report", "Simulated order; fulfillment handoff PREPARED, not sent"],
  10: ["results_profit", "report", "Actual vs TEST profit; UNKNOWN where costs unverified"],
};
const BEAT_ROLE = Object.fromEntries(Object.entries(BEAT_LABELS).map(([b, [, r]]) => [Number(b), r]));

async function tryDb(t, label, fn) {
  if (!t.dbOk) return null;
  try { return await fn(); }
  catch (e) { console.error("db mirror:", label, e.diagnostic || e.code || ""); return null; }
}

async function ensureDb(t) {
  if (t.dbOk === undefined) {
    t.dbOk = await db.dbAvailable();
    if (t.dbOk) {
      const s = await tryDb(t, "seed", () => db.seedCatalog(t.id, t.products.filter((p) => !String(p.id).includes("INVALID"))));
      if (s?.seeded) t.dbSeeded = s.count;
    }
  }
  return t.dbOk;
}

export async function startRun(tenantId, objective) {
  const t = get(tenantId);
  await ensureDb(t);
  const runId = `run-${Date.now().toString(36)}`;
  t.task_ids.push(runId);
  logEvent(t, { runId, beat: 0, actor: "orchestrator", kind: "RUN_STARTED", objective, decision: "ALLOW", note: "TEST demo mode" });
  await tryDb(t, "run", () => db.insertRun({ tenant_id: tenantId, run_id: runId, objective, state: "AWAITING_APPROVAL" }));
  await tryDb(t, "trace", () => db.insertTrace({ tenant_id: tenantId, run_id: runId, kind: "RUN_STARTED", beat: 0, actor: "orchestrator", decision: "ALLOW", note: `TEST demo — ${String(objective).slice(0, 120)}` }));
  const steps = [];
  for (const beat of [1, 2, 3, 4]) steps.push(await executeBeat(t, runId, beat, { objective }));
  steps.push(await executeBeat(t, runId, 5, {}));
  return { runId, steps, awaiting: "spending_approval" };
}

export async function decideSpend(tenantId, runId, approve, capSgd = 200) {
  const t = get(tenantId);
  const d = evaluate("order_from_supplier", { ownerConfirmed: !!approve, amountSgd: capSgd });
  if (!approve) {
    logEvent(t, { runId, beat: 5, actor: "human-gate", kind: "APPROVAL_DECLINED", decision: "NEVER", note: "owner declined; stops after beat 5; nothing was sent or spent" });
    await tryDb(t, "runstate", () => db.setRunState(tenantId, runId, "DECLINED_STOPPED"));
    await tryDb(t, "trace", () => db.insertTrace({ tenant_id: tenantId, run_id: runId, kind: "APPROVAL_DECLINED", beat: 5, actor: "human-gate", decision: "NEVER", note: "owner declined" }));
    await tryDb(t, "approval", () => db.upsertApproval({ tenant_id: tenantId, run_id: runId, approved: false, cap_sgd: 0, binding: "declined", decided_by: "OWNER" }));
    return { ok: true, outcome: "DECLINED_STOPPED" };
  }
  const binding = `resumes governed beats 6-10 (drafts/simulation only); real supplier order stays BLOCKED (${d.rule || "connector gate"}:${d.decision})`;
  t.spend_approval = { runId, approved: true, cap_sgd: capSgd, ts: new Date().toISOString(), binding, note: d.reason };
  logEvent(t, { runId, beat: 5, actor: "human-gate", kind: "APPROVAL_GRANTED", decision: "ALLOW", rule: "R12 owner-confirmed", evidence: binding });
  await tryDb(t, "approval", () => db.upsertApproval({ tenant_id: tenantId, run_id: runId, approved: true, cap_sgd: capSgd, binding, decided_by: "OWNER" }));
  await tryDb(t, "runstate", () => db.setRunState(tenantId, runId, "RUNNING"));
  await tryDb(t, "trace", () => db.insertTrace({ tenant_id: tenantId, run_id: runId, kind: "APPROVAL_GRANTED", beat: 5, actor: "human-gate", decision: "ALLOW", rule: "R12", note: `cap S$${capSgd} — governed resume only` }));
  const steps = [];
  for (const b of [6, 7, 8, 9, 10]) steps.push(await executeBeat(t, runId, b, { capSgd }));
  await tryDb(t, "runstate", () => db.setRunState(tenantId, runId, "COMPLETE"));
  return { ok: true, outcome: "RESUMED", note: "supplier order remains connector-gated; only governed drafts/simulation executed", steps };
}

async function receipt(t, runId, beat, extra = {}) {
  const [id, role, summary] = BEAT_LABELS[beat];
  const r = { runId, beat, id, role, summary, demo_mode: "TEST", policy_version: POLICY_VERSION, ts: new Date().toISOString(), ...extra };
  t.receipts.push(r);
  logEvent(t, { runId, beat, actor: role, kind: "BEAT_DONE", decision: r.decision || "ALLOW", note: r.blocked_reason || r.note || summary });
  await tryDb(t, `trace-${beat}`, () => db.insertTrace({ tenant_id: t.id, run_id: runId, kind: "BEAT_DONE", beat, actor: role, decision: r.decision || "ALLOW", rule: r.rule || null, note: r.blocked_reason || r.note || summary }));
  await tryDb(t, `receipt-${beat}`, () => db.insertReceipt({
    tenant_id: t.id, run_id: runId, beat, id, role, summary, decision: r.decision || "ALLOW",
    rule: r.rule || null, evidence: r.evidence || null, demo_mode: "TEST", ts: r.ts }));
  return r;
}

async function executeBeat(t, runId, beat, in_) {
  switch (beat) {
    case 5: return receipt(t, runId, 5, { decision: "APPROVE", awaiting: true,
      note: `spend cap offered S$${in_.capSgd ?? 200}; policy R12: new spend needs written owner confirmation` });
    case 6: {
      if (!t.spend_approval || t.spend_approval.runId !== runId) return receipt(t, runId, 6, { decision: "NEVER", blocked_reason: "no bound approval — marketing skipped" });
      return receipt(t, runId, 6, { evidence: { drafts: 3, channels: ["facebook_draft", "whatsapp_broadcast_draft", "email_draft"], all_state: "DRAFT_LOCAL_ONLY" },
        note: "drafts created locally; R03-R05 + connector gate: nothing leaves this system" }); }
    case 7: {
      const bad = injectInvalidRow(t);
      const d = evaluate("publish_product_listing", { dataLevel: "internal", ...bad });
      const blocked = d.decision !== "ALLOW";
      t.products = t.products.filter((p) => p.id !== "FNY-TEST-INVALID-999" || !blocked);
      return receipt(t, runId, 7, { decision: d.decision, rule: d.rule, blocked_reason: d.reason,
        evidence: { injected: bad, watch_action: blocked ? "REMOVED_BEFORE_DRAFT" : "ESCALATED", shield: ["monitor", "verify", "filter", "contain", "recover", "audit"] } }); }
    case 8: return receipt(t, runId, 8, { evidence: { shopee: "DRAFT_ONLY (seller auth NOT_CONNECTED)", whatsapp: "DRAFT — sending NOT authorized", email: "DRAFT" },
      note: "channel actions = drafts; live_publishing=false" });
    case 9: {
      const order = { tenant_id: t.id, order_id: `T-${Date.now().toString(36)}`, kind: "TEST_SIMULATED", amount: 552, currency: "MYR",
        sku: "FNY-WEB-002", supplier_cost: null, supplier_cost_verified: false, sent_to_supplier: false, ts: new Date().toISOString() };
      t.orders.push(order);
      await tryDb(t, "order", () => db.insertOrder(order));
      await tryDb(t, "handoff", () => db.insertHandoff({ tenant_id: t.id, order_id: order.order_id, state: "PREPARED_NOT_SENT", payload: { reason: "supplier terms not agreed — integration_ports.SupplierFulfillmentPort" } }));
      return receipt(t, runId, 9, { evidence: { order: order.order_id, fulfillment: "handoff PREPARED only — no supplier agreement; no automated fulfillment asserted", sent_to_supplier: false } }); }
    case 10: {
      const snap = profitSnapshot(t);
      await tryDb(t, "ledger", () => db.insertLedger([
        { tenant_id: t.id, run_id: runId, account: "sales_test_simulated", side: "credit", amount: 552, currency: "MYR", basis: "TEST — never actual" },
        { tenant_id: t.id, run_id: runId, account: "product_cost", side: "debit", amount: null, currency: "MYR", basis: "UNKNOWN — supplier_cost null (DB spec §4)" }]));
      await tryDb(t, "profit", () => db.insertProfit({ tenant_id: t.id, run_id: runId, snapshot: snap }));
      return receipt(t, runId, 10, { evidence: snap, note: "profit UNKNOWN where COGS unverified — never estimated as actual" }); }
    default: return receipt(t, runId, beat, { evidence: in_.objective ? { transcript: in_.objective } : demandEvidence() });
  }
}

function demandEvidence() { return { sources: ["MOH wellness spend summary (public)", "Shopee public category ranks", "Google Trends SG/MY public index"], method: "public-data synthesis for TEST demo", confidence: "directional" }; }
function injectInvalidRow(t) {
  const bad = { id: "FNY-TEST-INVALID-999", name: "Miracle Cure Drops", website_price: null, currency: "MYR", price_type: "ASSUMED_INVALID",
    regulatory_review_status: "FAILED", marketing_claims_approved: false, reseller_authorized: false,
    provenance: "SYNTHETIC WATCH-TEST FIXTURE (DB spec §1: AgentsWatchingAgents source is synthetic, not FNYGlobal truth)" };
  t.products.push({ ...bad, tenant_id: t.id, review_state: "QUARANTINE_BLOCKED" });
  return bad;
}

/* ---------- projections: DB-first, memory fallback ---------- */
async function dbState(tenantId) {
  const t = get(tenantId);
  if (!(await ensureDb(t))) return null;
  const run = await tryDb(t, "latest", () => db.readLatestRun(tenantId));
  if (!run) return null;
  const [rec, tr] = await Promise.all([
    tryDb(t, "receipts", () => db.readReceipts(tenantId, run.run_id)),
    tryDb(t, "trace", () => db.readTrace(tenantId, 40)),
  ]);
  return { run, rec: rec || [], tr: (tr || []).slice().reverse() };
}

export async function userView(tenantId) {
  const t = get(tenantId);
  const s = await dbState(tenantId);
  const receipts = s ? s.rec.map((r) => ({ beat: r.beat, decision: r.decision, awaiting: false, runId: r.run_id })) : t.receipts;
  const active = s?.run ?? (receipts.length ? receipts.at(-1).runId : null);
  const awaiting = s ? (s.run.state === "AWAITING_APPROVAL") : receipts.some((r) => r.awaiting);
  const done = (s ? s.rec.filter((r) => r.decision !== "APPROVE").map((r) => r.summary) : receipts.filter((r) => !r.awaiting).map((r) => BEAT_LABELS[r.beat]?.[2] ?? r.summary));
  return { objective: s?.run?.objective ?? t.trace.find((x) => x.kind === "RUN_STARTED")?.objective ?? null,
    "today's_business": { tasks_done: `${(s ? s.rec.filter((r) => r.decision !== "APPROVE" && r.decision !== "NEVER").length : receipts.filter((r) => !r.awaiting).length)}/10 beats`, data_state: "TEST · database" },
    whats_done: done.slice(-4), awaiting: awaiting ? "spending_approval" : null,
    company: { name: COMPANY.company_name, synthetic: COMPANY.is_synthetic, slot: COMPANY.profile_slot } };
}
export async function managementView(tenantId) {
  const t = get(tenantId);
  const s = await dbState(tenantId);
  const mission = s?.run?.objective ?? t.trace.find((x) => x.kind === "RUN_STARTED")?.objective ?? "—";
  const trace = s ? s.tr.map((e) => ({ ts: e.ts, runId: e.run_id, beat: e.beat, actor: e.actor, kind: e.kind, decision: e.decision, note: e.note }))
    : t.trace.slice(-60);
  const receipts = s ? s.rec.map((r) => ({ runId: r.run_id, beat: r.beat, id: r.id, summary: r.summary, decision: r.decision, demo_mode: r.demo_mode, awaiting: r.decision === "APPROVE" }))
    : t.receipts;
  return { specialists: SPECIALISTS, hub: "QwenWork AI brain", mission, trace, receipts, source: s ? "database" : "memory",
    company: { name: COMPANY.company_name, synthetic: COMPANY.is_synthetic },
    note: "decision summaries shown; private chain-of-thought never displayed (ui contract)" };
}
export async function securityView(tenantId) {
  const t = get(tenantId);
  const s = await dbState(tenantId);
  const all = s ? s.rec : t.receipts;
  const incidents = all.filter((r) => r.decision && r.decision !== "ALLOW" && r.decision !== "APPROVE")
    .map((r) => ({ ts: r.ts || r.created_at, kind: r.id || `beat ${r.beat}`, decision: r.decision, rule: r.rule, containment: "removed before draft (Layer 3+4)", simulation: "SIMULATED" }));
  const log = s ? s.tr.slice(-30) : t.trace.filter((x) => ["BEAT_DONE", "RUN_STARTED", "APPROVAL_GRANTED"].includes(x.kind)).slice(-30);
  return { label: "AI Hacking Simulation", shields: ["monitor", "verify", "filter", "contain", "recover", "audit"], incidents, log, source: s ? "database" : "memory" };
}
