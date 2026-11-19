/* odai/workflow.mjs — the canonical 10-beat demo, one shared backend, three projections.
 * Dispatch invariant (factory rule): every external-effect step passes M08 policy
 * BEFORE any side effect; BLOCK > HOLD > ALLOW; receipts carry evidence.
 * demo_mode is TEST everywhere: no external sends, no live publish, no real orders.
 */
import { get, logEvent, profitSnapshot } from "./store.mjs";
import { evaluate, POLICY_VERSION /* policy version tag for receipts */ } from "./policy.mjs";

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

export function startRun(tenantId, objective) {
  const t = get(tenantId);
  const runId = `run-${Date.now().toString(36)}`;
  t.task_ids.push(runId);
  logEvent(t, { runId, beat: 0, actor: "orchestrator", kind: "RUN_STARTED", objective, decision: "ALLOW", note: "TEST demo mode" });
  // beats 1-4 execute immediately (all read/draft-only, ALLOW by policy)
  const steps = [];
  for (const beat of [1, 2, 3, 4]) steps.push(executeBeat(t, runId, beat, { objective }));
  // beat 5 is the human gate — state persists until decided
  steps.push(executeBeat(t, runId, 5, {}));
  return { runId, steps, awaiting: "spending_approval" };
}

export function decideSpend(tenantId, runId, approve, capSgd = 200) {
  const t = get(tenantId);
  if (!approve) {
    logEvent(t, { runId, beat: 5, actor: "human-gate", kind: "APPROVAL_DECLINED", decision: "NEVER", note: "owner declined; stops after beat 5; nothing was sent or spent" });
    return { ok: true, outcome: "DECLINED_STOPPED" };
  }
  // Owner confirmation satisfies R12's human requirement for the GOVERNED RUN
  // (drafts + simulation only). Actual external effects (order_from_supplier,
  // pay_supplier, sends) remain connector-NEVER until provider readiness is
  // verified — enforced independently inside each beat's action.
  const d = evaluate("order_from_supplier", { ownerConfirmed: true, amountSgd: capSgd });
  t.spend_approval = { runId, approved: true, cap_sgd: capSgd, ts: new Date().toISOString(),
    binding: "resumes governed beats 6-10 (drafts/simulation only); real supplier order stays BLOCKED (" + (d.rule || "connector gate") + ":" + d.decision + ")", note: d.reason };
  logEvent(t, { runId, beat: 5, actor: "human-gate", kind: "APPROVAL_GRANTED", decision: "ALLOW", rule: "R12 owner-confirmed", evidence: t.spend_approval.binding });
  const steps = [6, 7, 8, 9, 10].map((b) => executeBeat(t, runId, b, { capSgd }));
  return { ok: true, outcome: "RESUMED", note: "supplier order remains connector-gated; only governed drafts/simulation executed", steps };
}

function receipt(t, runId, beat, extra = {}) {
  const [id, role, summary] = BEAT_LABELS[beat];
  const r = { runId, beat, id, role, summary, demo_mode: "TEST", policy_version: POLICY_VERSION, ts: new Date().toISOString(), ...extra };
  t.receipts.push(r);
  logEvent(t, { runId, beat, actor: role, kind: "BEAT_DONE", decision: r.decision || "ALLOW", note: r.blocked_reason || r.note || summary });
  return r;
}

function executeBeat(t, runId, beat, in_) {
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
        evidence: { injected: bad, watch_action: blocked ? "REMOVED_BEFORE_DRAFT" : "ESCALATED", shield: [ "monitor", "verify", "filter", "contain", "recover", "audit" ] } }); }
    case 8: return receipt(t, runId, 8, { evidence: { shopee: "DRAFT_ONLY (seller auth NOT_CONNECTED)", whatsapp: "DRAFT — sending NOT authorized", email: "DRAFT" },
      note: tenantCfgRef.channels });
    case 9: {
      const order = { id: `T-${Date.now().toString(36)}`, kind: "TEST_SIMULATED", amount: 552, currency: "MYR", product: "FNY-WEB-002 (UA1290 Set, public listed MYR552)", supplier_cost_verified: false, ts: new Date().toISOString() };
      t.orders.push(order);
      return receipt(t, runId, 9, { evidence: { order: order.id, fulfillment: "handoff PREPARED only — no supplier agreement (integration_ports: SupplierFulfillmentPort requires signed agreement + verification)", sent_to_supplier: false } }); }
    case 10: {
      const snap = profitSnapshot(t);
      return receipt(t, runId, 10, { evidence: snap, note: "profit UNKNOWN where COGS unverified — never estimated as actual" }); }
    default: return receipt(t, runId, beat, { evidence: in_.objective ? { transcript: in_.objective } : demandEvidence() });
  }
}
const tenantCfgRef = { channels: "all channel actions = drafts; live_publishing=false" };
function demandEvidence() { return { sources: ["MOH wellness spend summary (public)", "Shopee public category ranks", "Google Trends SG/MY public index"], method: "public-data synthesis for TEST demo", confidence: "directional" }; }
function injectInvalidRow(t) {
  const bad = { id: "FNY-TEST-INVALID-999", name: "Miracle Cure Drops", website_price: null, currency: "MYR", price_type: "ASSUMED_INVALID", regulatory_review_status: "FAILED", marketing_claims_approved: false, reseller_authorized: false, provenance: "SYNTHETIC WATCH-TEST FIXTURE (DB spec §1: AgentsWatchingAgents is synthetic, not FNYGlobal truth)" };
  t.products.push({ ...bad, tenant_id: t.id, review_state: "QUARANTINE_BLOCKED" });
  return bad;
}

/* projections the three modes render from ONE backend */
export function userView(tenantId) {
  const t = get(tenantId);
  const done = t.receipts.filter((r) => !r.awaiting).map((r) => r.summary);
  return { objective: t.trace.find((x) => x.kind === "RUN_STARTED")?.objective ?? null,
    "today's_business": { sales: "see TEST ledger", tasks_done: `${t.receipts.length}/10 beats`, data_state: "TEST" },
    whats_done: done.slice(-4), awaiting: t.receipts.some((r) => r.awaiting) ? "spending_approval" : null };
}
export function managementView(tenantId) {
  const t = get(tenantId);
  return { specialists: SPECIALISTS, hub: "QwenWork AI brain", mission: t.trace.find((x) => x.kind === "RUN_STARTED")?.objective ?? "—",
    trace: t.trace.slice(-60), receipts: t.receipts, note: "decision summaries shown; private chain-of-thought never displayed (ui contract)" };
}
export function securityView(tenantId) {
  const t = get(tenantId);
  const incidents = t.receipts.filter((r) => r.decision && r.decision !== "ALLOW")
    .map((r) => ({ ts: r.ts, kind: r.id, decision: r.decision, rule: r.rule, containment: "removed before draft (Layer 3+4)", simulation: "SIMULATED" }));
  return { label: "AI Hacking Simulation", shields: ["monitor", "verify", "filter", "contain", "recover", "audit"], incidents, log: t.trace.filter((x) => ["BEAT_DONE", "RUN_STARTED", "APPROVAL_GRANTED"].includes(x.kind)).slice(-30) };
}
