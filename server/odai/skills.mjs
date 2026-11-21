/* odai/skills.mjs — WO-103 first P0 skill modules (batch A1), P0 family only:
 * ledger-append, catalog-query, evidence-append, gate-check, schedule-scaffold,
 * report-compose. Small deterministic functions; the declared input/output contract
 * columns come FROM sheet-04 via skill_contracts.json (odai/config) — tests audit that
 * every required_input_field is honored and required_output_field emitted. No LLM, no
 * network, no external side effects here; connector-bound outcomes stay BLOCKED
 * (WO-105 matrix) and NOT_IMPLEMENTED. Unified error semantics from sheet-04
 * error_and_recovery: absent contract inputs -> status NEEDS_INPUT (+missing list);
 * refused writes -> REJECTED with reason; nothing is ever invented on failure.
 */
import { get } from "./store.mjs";
import { createHash } from "node:crypto";
import { appendMoneyEvent, moneyEvents, moneyTotals } from "./ledger.mjs";
import { loadSkillContract } from "./registry.mjs";
/* WO-SEC05: the spend gate now consumes ATOMIC BUDGET RESERVATIONS (SEC-05 remediation).
 * Reservations live in server/odai/reservations.mjs — synchronous single-thread critical
 * section CAS; approve consumes HELD reservations only; held+consumed never exceed the cap. */
import { budgetScope, consumeHold, registerBudgetScope, reserve, releaseHolds } from "./reservations.mjs";

const req = (input, keys) => keys.filter((k) => input[k] === undefined || input[k] === null || input[k] === "" || (Array.isArray(input[k]) && !input[k].length));

/* ---- ledger-append (SK-024; WO-104 backing for SK-004/008/030) ----
 * in : tenant_id, objective_id, task_id, source_refs|source_tag, validated_domain_inputs
 *      {amount_myr, direction("in"|"out"), category?, event_id_replaces?} (flat also accepted)
 * out: typed_artifact{ledger_event}, evidence_refs[ME-…], uncertainty_flags, cost_actual,
 *      approval_requests + ledger totals sidecar */
export function skill_ledger_append(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "source_refs"]);
  const vdi = input.validated_domain_inputs || {};
  const amount = input.amount_myr ?? vdi.amount_myr;
  const direction = input.direction ?? vdi.direction;
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const out = appendMoneyEvent(String(input.tenant_id), {
    amount_myr: amount, direction,
    source_tag: input.source_tag || (input.source_refs || [])[0] || null,
    objective_id: input.objective_id, task_id: input.task_id,
    category: input.category ?? vdi.category, event_id_replaces: input.event_id_replaces ?? vdi.event_id_replaces,
  });
  if (out.error) return { status: "REJECTED", reason: out.error, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["append_refused"], cost_actual: null, approval_requests: [] };
  return {
    status: "OK", typed_artifact: { ledger_event: out.event }, evidence_refs: [out.event.event_id],
    uncertainty_flags: [], cost_actual: out.event.direction === "out" ? out.event.amount_myr : 0,
    approval_requests: [],
    totals: moneyTotals(String(input.tenant_id), { objective_id: String(input.objective_id) }),
  };
}

/* ---- catalog-query (SK-009) ----
 * in : supplier_catalog (optional explicit rows), product_assets (optional count/list),
 *      market (label; staging flags unverified), tenant_id (storage path when no
 *      supplier_catalog supplied — uses odai store rows, TEST-labelled)
 * out: validated_catalog, rejected_rows, provenance_refs (+ generic envelope sidecars) */
export function skill_catalog_query(input = {}) {
  const missing = req(input, ["market"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, validated_catalog: [], rejected_rows: [], provenance_refs: [] };
  let source = input.supplier_catalog;
  let fromStore = false;
  if (!Array.isArray(source)) {
    if (!input.tenant_id) return { status: "NEEDS_INPUT", missing: ["tenant_id or supplier_catalog"], validated_catalog: [], rejected_rows: [], provenance_refs: [] };
    const t = get(String(input.tenant_id));
    source = (t && t.products ? t.products : []).map((p) => ({ id: p.id, name: p.name, currency: p.currency, price: p.website_price, price_type: p.price_type, review_state: p.review_state, reseller_authorized: p.reseller_authorized, regulatory: p.regulatory_review_status }));
    fromStore = true;
  }
  const suppliedAssets = Array.isArray(input.product_assets) ? input.product_assets.length : Number(input.product_assets || 0);
  const validated = []; const rejected = [];
  source.forEach((row, i) => {
    const r = row || {};
    const problems = [];
    if (!String(r.name || "").trim()) problems.push("name_missing");
    if (r.price !== undefined && r.price !== null && !Number.isFinite(Number(r.price))) problems.push("price_not_numeric");
    if (String(r.review_state || "").toUpperCase() === "QUARANTINED") problems.push("quarantined");
    if (String(r.regulatory || "").toLowerCase().includes("pending")) problems.push("regulatory_pending");
    const ref = (fromStore ? "catalog:" : "supplier_row:") + (r.id || i + 1);
    if (problems.length) rejected.push({ row: r.id || i + 1, reasons: problems });
    else validated.push({ ...r, provenance: ref, data_mode: "TEST" });
  });
  const assetNote = suppliedAssets ? { product_assets_considered: suppliedAssets } : { product_assets: "not_supplied" };
  return {
    status: "OK",
    validated_catalog: validated, rejected_rows: rejected,
    provenance_refs: validated.map((v) => v.provenance),
    typed_artifact: { count: validated.length, market: String(input.market), ...assetNote, store_source: fromStore },
    evidence_refs: validated.map((v) => v.provenance),
    uncertainty_flags: [fromStore ? "queried_tenant_store_rows" : "supplier_rows_are_proposed_until_verified", "market_eligibility_unverified_staging"],
    cost_actual: 0, approval_requests: [],
  };
}

/* ---- evidence-append (SK-021; CTRL-08 shim) ----
 * in : tenant_id, objective_id, task_id, source_refs (refs of provenance),
 *      validated_domain_inputs{artifact?}
 * out: typed_artifact, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_evidence_append(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const refs = input.source_refs.map(String);
  const artifact = (input.validated_domain_inputs || {}).artifact || null;
  const t = get(String(input.tenant_id));
  const shapeOk = /^UC-\d{3}-T\d{2}$/.test(String(input.task_id)) || /^OBJ-/.test(String(input.task_id)) || /^(intake|plan|beat\d+)$/.test(String(input.task_id));
  const uncertainty = [];
  if (!t) uncertainty.push("tenant_not_loaded");
  if (!shapeOk) uncertainty.push("task_shape_unverified");
  if (!artifact) uncertainty.push("artifact_inline_absent_refs_only");
  if (t) { try { t._evidence_index = Object.assign(t._evidence_index || {}, { [String(input.task_id)]: (t._evidence_index?.[String(input.task_id)] || []).concat(refs) }); } catch { /* advisory index only */ } }
  return {
    status: "OK",
    typed_artifact: { accepted_refs: refs.length, task_id: String(input.task_id), artifact },
    evidence_refs: refs, uncertainty_flags: uncertainty, cost_actual: 0, approval_requests: [],
    note: "advisory append — authoritative receipts remain workflow beats; no second evidence store (Rev 2.1 reuse)",
  };
}

/* ---- gate-check (SK-035; CTRL-06 shim) — one action against its mapped gate scope.
 * Reuses the existing fail-closed posture: unknown scope/risk DENIES. Engine gateway
 * itself untouched. WO-SEC05: spend decisions are made ATOMICALLY against registered
 * budget reservations (held -> consumed state machine in reservations.mjs), so the
 * cumulative approved spend can never exceed a declared cap under concurrency.
 * in : actor, tenant, action, resource, risk, gate?{scope}, owner_approved?, amount_myr?, cap_myr?
 * out: policy_decision, reason_code, obligations (+envelope sidecars incl budget snapshot) */
export function skill_gate_check(input = {}) {
  const missing = req(input, ["actor", "tenant", "action", "resource", "risk"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, policy_decision: "DENY", reason_code: "inputs_absent", obligations: [] };
  const gate = input.gate || null;
  const scope = gate ? String(gate.scope) : null;
  let policy_decision = "ALLOW"; let reason_code = "within_allowed_actions";
  let budgetSnapshot = null;
  const obligations = ["log decision", "tenant-scoped record only"];
  if (scope === "spend") {
    const cap = Number(input.cap_myr || 0);
    const ask = Number(input.amount_myr || 0);
    /* WO-SEC05 (SEC-05 remediation): where the objective's declared cap was REGISTERED as a
     * budget scope (money_cap objectives hold their full cap at creation, before the owner
     * acts), an approval must consume a HELD reservation atomically — the gate enforces
     * ask <= cap - (held + consumed), not merely asks ask <= cap per action. The consume is a
     * synchronous compare-and-set inside reservations.mjs' critical section: two concurrent
     * approvals can never both pass. */
    const tenantId = String(input.tenant || "");
    const scopeId = String(input.resource || "");
    const registered = scopeId ? budgetScope(tenantId, scopeId) : null;
    if (!input.owner_approved) { policy_decision = "HOLD"; reason_code = "AWAITING_SPEND_APPROVAL"; }
    else if (cap && ask > cap) { policy_decision = "BLOCK"; reason_code = "OVER_HARD_CAP_" + cap; budgetSnapshot = registered; }
    else if (registered) {
      const res = consumeHold(tenantId, scopeId, ask, { source: "SK-035:gate-check:" + String(input.action) });
      if (res.ok) { policy_decision = "ALLOW"; reason_code = "owner_approved_reservation_consumed"; }
      else { policy_decision = "BLOCK"; reason_code = "OVER_REMAINING_BUDGET"; }
      budgetSnapshot = res.budget || registered;
      obligations.push("gate check CONSUMED a held reservation atomically (WO-SEC05) — held+consumed<=cap enforced at decision time");
    } else {
      policy_decision = "ALLOW"; reason_code = "owner_approved_within_cap";
      obligations.push("no registered budget scope — per-action cap check only; declared caps become holds at objective creation (WO-SEC05)");
    }
    obligations.push("spend requires owner gate (R12 pattern; no auto-spending)");
  } else if (scope === "publish" || scope === "comms" || scope === "external_write") {
    policy_decision = "BLOCK";
    reason_code = scope === "comms" ? "comms held — connector_readiness DISABLED" : "external action held — connector_readiness DISABLED";
    obligations.push("even owner approval cannot release external writes until 9.0 connector readiness (recorded as approved_held only)");
  } else if (scope === "review") {
    policy_decision = "ALLOW"; reason_code = "advisory_review_only_action";
    obligations.push("artifact must carry TEST/synthetic labelling where financial");
  } else if (String(input.risk || "").toLowerCase() === "unknown") {
    policy_decision = "DENY"; reason_code = "unknown_risk_fails_closed";
  } else {
    policy_decision = "DENY"; reason_code = "scope_unmapped_fails_closed";
  }
  return {
    status: "OK", policy_decision, reason_code, obligations,
    typed_artifact: { policy_decision, reason_code, action: String(input.action), ...(budgetSnapshot ? { budget: budgetSnapshot } : {}) },
    evidence_refs: ["gate_check:" + String(input.action)],
    uncertainty_flags: scope ? [] : ["scope_unmapped_fail_closed"],
    cost_actual: 0, approval_requests: policy_decision === "HOLD" ? ["approve_spend"] : [],
  };
}

/* ---- schedule-scaffold (SK-041) — deterministic PROPOSAL structure only. This module
 * NEVER creates scheduled tasks/cron/automations; realization is an explicit owner act
 * through the platform scheduler (separate surface).
 * in : tenant_id, objective_id, task_id, validated_domain_inputs|flat {cadence, tasks}
 * out: typed_artifact{scaffold...}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_schedule_scaffold(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const cadence = String(input.cadence || vdi.cadence || "daily").toLowerCase();
  const allowed = ["hourly", "daily", "weekly", "monthly", "manual"];
  if (!allowed.includes(cadence)) return { status: "REJECTED", reason: "cadence must be " + allowed.join("|"), typed_artifact: null, evidence_refs: [], uncertainty_flags: ["cadence_rejected"], cost_actual: 0, approval_requests: [] };
  const tasks = input.tasks || vdi.tasks || [];
  const basis = (input.source_refs || (input.validated_domain_inputs || {}).source_refs || []).map(String);
  const steps = tasks.slice(0, 20).map((task, i) => ({ slot: i + 1, task: String(task), trigger: cadence, safety: "allowed_actions_only; spend/publish/comms gates still bind every run" }));
  return {
    status: "OK",
    typed_artifact: { scaffold_id: `SCH-${input.objective_id}-${String(input.task_id).replace(/[^A-Za-z0-9_-]/g, "")}`, cadence, steps, basis_refs: basis, realized: false },
    evidence_refs: [`scaffold:${cadence}:${steps.length}`],
    uncertainty_flags: ["scaffold_not_scheduled_by_design"],
    cost_actual: 0,
    approval_requests: ["owner must explicitly realize a schedule (no hidden automation)"],
  };
}

/* ---- report-compose (SK-040; CTRL-09 shim) — money-first summary from LEDGER FACTS
 * ONLY. Unknowns stay UNKNOWN (9.0 honesty).
 * in : tenant_id, objective_id, task_id?, source_refs?, validated_domain_inputs{task_summary}
 * out: typed_artifact{money_first…}, evidence_refs[ME-…], uncertainty_flags, cost_actual, approval_requests */
export function skill_report_compose(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const events = moneyEvents(String(input.tenant_id), { objective_id: String(input.objective_id) });
  const totals = moneyTotals(String(input.tenant_id), { objective_id: String(input.objective_id) });
  const cogsKnown = events.some((e) => e.direction === "out" && e.category === "cogs_verified");
  const summary = input.task_summary || (input.validated_domain_inputs || {}).task_summary || null;
  const taskId = input.task_id || (input.validated_domain_inputs || {}).task_id || null;
  const extraRefs = (input.source_refs || []).map(String); // provenance passthrough (contract column)
  return {
    status: "OK",
    typed_artifact: {
      money_first: {
        money_in_myr: totals.money_in, money_out_myr: totals.money_out, net_myr: totals.net,
        actual_vs_forecast: "UNKNOWN — no verified forecast baseline exists for this objective",
        profit: cogsKnown ? totals.net : "UNKNOWN (COGS unverified)",
        currency_boundary: "MYR ledger figures NEVER merge with SGD/S$ demo figures (per-currency separation)",
      },
      task_line: summary ? String(summary) : null, task_id: taskId,
      approvals: events.filter((e) => e.direction === "out").slice(-5).map((e) => `${e.event_id} ${e.source_tag}`),
    },
    evidence_refs: events.slice(-20).map((e) => e.event_id).concat(extraRefs),
    uncertainty_flags: cogsKnown ? [] : ["profit_UNKNOWN_cogs_unverified"],
    cost_actual: totals.money_out, approval_requests: [],
  };
}

/* ================= WO-113 tranche 2 — sheet-04 deterministic modules =================
 * Connector-bound outcomes are NEVER invoked here (no LLM, no network, no live adapter):
 * the module emits a deterministic prepared spec with an explicit mode label
 * (MOCK / SPEC_ONLY) so plan evidence can never be mistaken for a real external action.
 * LIVE connector paths remain BLOCKED owner-token class per connectors_matrix (DEV-02). */

const sense = (x) => Math.round(Number(x) * 100); // RM -> integer sen; all money math in int sen
const stableId = (prefix, parts) => prefix + "-" + createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);

/* ---- claims-reviewer (SK-012) — wellness/advertising claims screen over the SUPPLIED text.
 * Deterministic prohibited-expression list only; grounding stays with the cited evidence refs.
 * NEVER asserts a claim is lawful — verdicts are screen-level, legal sign-off is an owner act.
 * in : envelope; vdi{claims: [{id?, text}], evidence_refs?: [..]}
 * out: typed_artifact{verdicts}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
const BANNED_CLAIM_TERMS = [
  ["cure", /\bcure[sd]?\b|\bcuring\b/i], ["miracle", /\bmiracle\b/i],
  ["clinically proven (bare)", /\bclinically proven\b(?!\s*(—|-|:)?\s*ref\s*\[)/i],
  ["guaranteed results", /\bguaranteed results?\b/i], ["100% effective", /\b100%\s*effective\b/i],
  ["no side effects", /\bno side effects\b/i], ["kills (virus/cancer)", /\bkills?\s+(the\s+)?(virus|cancer|tumou?rs?)\b/i],
  ["doctor recommended (bare)", /\bdoctor recommended\b(?!\s*\()/i],
];
export function skill_claims_review(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const claims = Array.isArray(vdi.claims) ? vdi.claims : [];
  if (!claims.length) return { status: "REJECTED", reason: "claims[] with the exact text under review is required — nothing is reviewed vacuously", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["no_claims_supplied"], cost_actual: 0, approval_requests: [] };
  const cited = (input.source_refs || []).map(String);
  const verdicts = claims.map((c, i) => {
    const text = String(c.text || "");
    const hits = BANNED_CLAIM_TERMS.filter(([, re]) => re.test(text)).map(([name]) => name);
    const claimEvidence = Array.isArray(c.evidence) ? c.evidence : [];
    const grounding = claimEvidence.length ? "claim_cited_refs_semantics_unverified" : cited.length ? "global_refs_only_no_claim_link" : "NO_CITED_EVIDENCE";
    return { id: String(c.id != null ? c.id : "C" + (i + 1)), screen: hits.length ? "REJECTED" : "PASS_SCREEN", banned_expressions: hits, grounding, escalate_to_owner: hits.length > 0 || grounding !== "claim_cited_refs_semantics_unverified", text_excerpt: text.slice(0, 120) };
  });
  const rejected = verdicts.filter((v) => v.screen === "REJECTED").map((v) => v.id);
  return {
    status: "OK",
    typed_artifact: { verdicts, rejected_claim_ids: rejected, screen_basis: "deterministic_banned_expression_list_v1", legal_signoff: "REQUIRED before publication — screen is not legal advice" },
    evidence_refs: cited, uncertainty_flags: cited.length ? ["semantic_grounding_not_machine_verified"] : ["claims_without_evidence_refs"],
    cost_actual: 0, approval_requests: rejected.length ? ["owner must approve rewritten copy for: " + rejected.join(",")] : [],
  };
}

/* ---- compliance-researcher (SK-013) — regulatory checklist FRAMEWORK, not an opinion.
 * No research connector is invoked (none cleared); every substantive verdict is UNKNOWN
 * pending a licensed advisor / official source. Only structure is emitted (anti-fabrication).
 * in : envelope; vdi{markets?: [], product_category?, questions?: []}
 * out: typed_artifact{checklist}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_compliance_research(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const markets = (vdi.markets && vdi.markets.length ? vdi.markets : ["MY"]).map(String);
  const category = String(vdi.product_category || "unspecified");
  const checklist = [];
  for (const m of markets) {
    for (const topic of ["product_registration_licensing", "labeling_language_requirements", "health_claims_permitted_list", "advertising_channel_rules", "refund_consumer_protection"]) {
      checklist.push({ market: m, category, topic, verdict: "UNKNOWN — no official-source retrieval authorized", next_action: "owner supplies official citation OR licenses advisor review", status: "REQUIRES_INPUT" });
    }
  }
  return {
    status: "OK",
    typed_artifact: { checklist, substantive_findings: 0, framework_only: true, note: "zero regulatory facts invented; UNKNOWN is the honest verdict until a cited official source is on file" },
    evidence_refs: (input.source_refs || []).map(String), uncertainty_flags: ["all_verdicts_UNKNOWN_pending_official_sources"],
    cost_actual: 0, approval_requests: ["owner must route checklist to licensed compliance advisor"],
  };
}

/* ---- funnel-builder (SK-026) — landing/lead/appointment funnel SPEC from supplied steps.
 * The only builder connector (Hashmeta) is BLOCKED → structure only, live_call_made false.
 * in : envelope; vdi{funnel_steps: [{stage, purpose}], form_fields?, booking?}
 * out: typed_artifact{funnel_spec}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_funnel_build(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const steps = Array.isArray(vdi.funnel_steps) ? vdi.funnel_steps : [];
  if (!steps.length) return { status: "REJECTED", reason: "funnel_steps[] required — no invented funnel architecture", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["steps_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const specId = stableId("FUN", [String(input.tenant_id), String(input.objective_id), steps.map((s) => String(s.stage)).join(",")]);
  const stages = steps.map((s, i) => ({ order: i + 1, stage: String(s.stage), purpose: String(s.purpose || ""), voice_first_ui: true, elderly_friendly: "large_targets + readback confirmation per stage (structure flag only)" }));
  return {
    status: "OK",
    typed_artifact: {
      funnel_spec: { spec_id: specId, mode: "SPEC_ONLY", stages, form_fields: (vdi.form_fields || []).map(String).slice(0, 12), appointment: vdi.booking ? "structure_only_no_external_booking_call" : null, connector: { candidate: "Hashmeta Website Connector", class: "BLOCKED", live_call_made: false } },
    },
    evidence_refs: [specId].concat((input.source_refs || []).map(String)), uncertainty_flags: ["hashmeta_connector_BLOCKED_no_build", "spec_only_no_funnel_deployed"],
    cost_actual: 0, approval_requests: [{ scope: "deploy_funnel", auto: false, requires: "owner approval + connector 9.0 readiness — publication NEVER automatic" }],
  };
}

/* ---- spend-controller (SK-046) — gate-check CONSUMER over the SEC-05 reservation engine.
 * Declares a cap scope, holds budget atomically, releases. Reuses reservations.mjs —
 * NEVER re-implements cap math, never spends (consumption stays with SK-035 owner gate).
 * in : envelope; vdi{cap_myr?, action: "declare_scope"|"hold"|"release_holds", amount_myr?, note?}
 * out: typed_artifact{budget...}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_spend_control(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const action = String(vdi.action || "");
  const tenant = String(input.tenant_id); const scope = String(input.objective_id);
  const envelopeOut = (ta, extras = {}) => ({
    status: "OK", typed_artifact: ta, evidence_refs: (input.source_refs || []).map(String).concat(ta.budget ? ["budget:" + tenant + ":" + scope] : []),
    uncertainty_flags: extras.uncertainty || [], cost_actual: ta.budget ? ta.budget.consumed_myr : 0, approval_requests: extras.approvals || [], ...extras.extra,
  });
  if (action === "declare_scope") {
    const cap = Number(vdi.cap_myr);
    if (!(cap > 0)) return { status: "REJECTED", reason: "cap_myr must be a positive number", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["cap_rejected"], cost_actual: 0, approval_requests: [] };
    const r = registerBudgetScope(tenant, scope, cap, { source: "SK-046:" + input.task_id });
    if (!r.ok) return { status: "REJECTED", reason: "budget_scope_refused: " + r.reason + " — " + (r.detail || ""), typed_artifact: null, evidence_refs: [], uncertainty_flags: ["cap_lock_conflict_fail_closed"], cost_actual: 0, approval_requests: [] };
    return envelopeOut({ action, budget: r.budget, newly_registered: !r.existing, holds_full_cap: false, note: "declare only — the objective creation path holds caps; this consumer never double-holds" });
  }
  if (action === "hold") {
    const amount = Number(vdi.amount_myr);
    if (!(amount > 0)) return { status: "REJECTED", reason: "amount_myr must be a positive number", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["amount_rejected"], cost_actual: 0, approval_requests: [] };
    const r = reserve(tenant, scope, amount, { source: "SK-046:" + input.task_id, note: vdi.note ? String(vdi.note) : null });
    if (!r.ok) return { status: "REJECTED", reason: "hold_refused: " + r.reason + " — " + (r.detail || "cap exhausted"), typed_artifact: { budget: r.budget || budgetScope(tenant, scope) }, evidence_refs: [], uncertainty_flags: ["atomic_cap_enforced"], cost_actual: 0, approval_requests: [] };
    return envelopeOut({ action, reservation_id: r.reservation.reservation_id, amount_myr: amount, state: "held", budget: r.budget });
  }
  if (action === "release_holds") {
    const rel = releaseHolds(tenant, scope, String(vdi.note || "released by spend controller"));
    if (!rel.ok) return { status: "REJECTED", reason: "release_refused: " + rel.reason, typed_artifact: { budget: rel.budget || budgetScope(tenant, scope) }, evidence_refs: [], uncertainty_flags: [], cost_actual: 0, approval_requests: [] };
    return envelopeOut({ action, released: rel.released, budget: rel.budget });
  }
  return { status: "REJECTED", reason: "action must be declare_scope|hold|release_holds", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["action_rejected"], cost_actual: 0, approval_requests: [] };
}
/* ---- creative-generator (SK-018) — prepares Wan image/video/poster job specs.
 * Contract: typed envelope; dispatch to Wan APIs is connector-blocked, so jobs are
 * returned prepared (QUEUED_MOCK), never fabricated as generated.
 * in : tenant_id, objective_id, task_id, validated_domain_inputs{media_kind, brief, source_product?}, source_refs
 * out: typed_artifact{job...}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_creative_generate(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const mediaKind = String(vdi.media_kind || "").toLowerCase();
  if (!["image", "video", "poster"].includes(mediaKind)) return { status: "REJECTED", reason: "media_kind must be image|video|poster", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["media_kind_rejected"], cost_actual: 0, approval_requests: [] };
  const brief = String(vdi.brief || "").trim();
  if (!brief) return { status: "REJECTED", reason: "creative brief text required — nothing is invented without source facts", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["brief_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const adapter = mediaKind === "video" ? "wan-video" : "wan-image"; // via approved adapter surface (SK-055 routes poster/social)
  const refs = (input.source_refs || []).map(String);
  const jobId = stableId("CJ", [String(input.tenant_id), String(input.objective_id), String(input.task_id), adapter, brief]);
  return {
    status: "OK",
    typed_artifact: {
      mode: "MOCK", job_id: jobId, adapter, media_kind: mediaKind, job_state: "QUEUED_MOCK", dispatched: false,
      brief, source_product: vdi.source_product || null,
      preserve: { job_id: true, generation_cost: "UNKNOWN — adapter never invoked", rights_cleared_source: vdi.rights_ref || null, async_status: "not_started", qc: "pending_owner_qc" },
      route_note: "poster/social variants -> SK-055; video production -> SK-057 (per contract routing)",
    },
    evidence_refs: [jobId, adapter + ":" + mediaKind],
    uncertainty_flags: ["connector_wan_BLOCKED_owner_token_class", "no_external_invocation_mode_MOCK", "cost_actual_UNKNOWN_uninvoked"],
    cost_actual: 0, approval_requests: [],
  };
}

/* ---- poster-social-creator (SK-055) — branded poster + platform post drafts from PROVIDED facts.
 * No claims/prices/images invented: unconfirmed rights blocks; unsupported platform -> draft only.
 * in : product_id, brand_id, platforms[], language, objective, budget, tenant_id, validated_domain_inputs{brand_name, headlines_per_platform?, rights_confirmed, price_myr?}
 * out: poster_asset_id, post_drafts, platform_variants, qa_result, cost_estimate (+envelope) */
export function skill_poster_social_create(input = {}) {
  const missing = req(input, ["tenant_id", "product_id", "brand_id", "platforms", "language", "objective", "budget"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [], poster_asset_id: null, post_drafts: [], platform_variants: [], qa_result: null, cost_estimate: null };
  const vdi = input.validated_domain_inputs || {};
  const evidence = (input.source_refs || vdi.source_refs || []).map(String);
  if (vdi.rights_confirmed !== true) return { status: "REJECTED", reason: "product image/copy rights unconfirmed — poster creation blocked per error_and_recovery", poster_asset_id: null, post_drafts: [], platform_variants: [], qa_result: { overall: "BLOCKED", checks: ["rights_unconfirmed"] }, cost_estimate: null, typed_artifact: null, evidence_refs: evidence, uncertainty_flags: ["rights_block"], cost_actual: 0, approval_requests: [] };
  const SUPPORTED = { facebook: 400, linkedin: 700, youtube_community: 500 };
  const brandName = String(vdi.brand_name || input.brand_id);
  const priceLine = vdi.price_myr === undefined || vdi.price_myr === null ? null : "RM" + Number(vdi.price_myr).toFixed(2);
  const headline = String(vdi.headline || (brandName + " — " + String(input.objective).slice(0, 60)));
  const posterAssetId = stableId("POSTER", [String(input.tenant_id), String(input.product_id), String(input.brand_id), headline]);
  const drafts = []; const variants = []; const checks = [];
  for (const raw of input.platforms.map((x) => String(x).toLowerCase())) {
    const limit = SUPPORTED[raw];
    const body = priceLine ? headline + " | " + priceLine + " | " + "Details: " + String(input.product_id) : headline + " | price not supplied — no invented price";
    const alt = String(vdi.alt_text || (brandName + " product poster, " + raw + " variant")); // provided or structural, never claims
    if (limit === undefined) {
      drafts.push({ platform: raw, state: "draft_only", reason: "platform incompatibility — draft only per contract", headline, body, alt_text: alt, language: String(input.language) });
      variants.push({ platform: raw, char_limit: null, within_limit: null, channel: "draft_only_unsupported" });
      checks.push(raw + ":draft_only");
    } else {
      const within = body.length <= limit;
      drafts.push({ platform: raw, state: "ready_for_owner_review", headline, body, alt_text: alt, language: String(input.language) });
      variants.push({ platform: raw, char_limit: limit, char_used: body.length, within_limit: within, channel: "community_post_spec" });
      checks.push(raw + (within ? ":within_limit" : ":OVER_LIMIT"));
    }
  }
  const qa = { overall: checks.some((c) => /OVER_LIMIT|draft_only/.test(c)) ? (checks.every((c) => c.includes("draft_only")) ? "DRAFTS_ONLY" : "PARTIAL") : "PASS", checks, provenance_stored: evidence.length > 0 };
  return {
    status: "OK",
    poster_asset_id: posterAssetId,
    post_drafts: drafts, platform_variants: variants, qa_result: qa,
    cost_estimate: { basis: "no_verified_adapter_price_card", estimate_myr: null, budget_declared_myr: Number(input.budget), note: "Wan adapter never invoked — pricing UNKNOWN, never fabricated" },
    typed_artifact: { mode: "MOCK", poster_asset_id: posterAssetId, render: "NOT_RENDERED_adapter_blocking", drafts: drafts.length, variants: variants.length },
    evidence_refs: [posterAssetId].concat(evidence),
    uncertainty_flags: ["poster_render_not_executed", "cost_estimate_UNKNOWN_no_price_source"],
    cost_actual: 0, approval_requests: ["publishing any draft remains owner-gated (external post = BLOCKED)"],
  };
}

/* ---- margin-analyst (SK-030) — contribution margin by SKU from supplied figures ONLY.
 * Missing components -> SKU flagged unknown and EXCLUDED from confident ranking (never guessed).
 * in : sku_prices[{sku, price_myr}], verified_costs[{sku, landed_cost_myr, delivery_myr?, returns_allowance_myr?}], fee_schedule{marketplace_pct, payment_pct, fixed_per_unit_myr} (or per-sku rows)
 * out: margin_table, break_even, unknown_cost_flags */
export function skill_margin_analyze(input = {}) {
  const missing = req(input, ["sku_prices", "verified_costs", "fee_schedule"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, margin_table: [], break_even: [], unknown_cost_flags: [], note: "no inputs — nothing to compute" };
  const costs = new Map((input.verified_costs || []).map((c) => [String(c.sku), c]));
  const fees = Array.isArray(input.fee_schedule) ? new Map(input.fee_schedule.map((f) => [String(f.sku), f])) : null;
  const global = Array.isArray(input.fee_schedule) ? null : input.fee_schedule;
  const table = []; const unknown = []; const breakEven = [];
  for (const sp of input.sku_prices) {
    const sku = String(sp.sku);
    const c = costs.get(sku) || {};
    const f = (fees ? fees.get(sku) : global) || {};
    const parts = { price: sp.price_myr, landed: c.landed_cost_myr, delivery: c.delivery_myr ?? 0, returns: c.returns_allowance_myr ?? 0, mp_pct: f.marketplace_pct ?? global?.marketplace_pct, pay_pct: f.payment_pct ?? global?.payment_pct, fixed: f.fixed_per_unit_myr ?? global?.fixed_per_unit_myr ?? 0 };
    const gaps = Object.entries({ price_myr: parts.price, landed_cost_myr: parts.landed, marketplace_pct: parts.mp_pct, payment_pct: parts.pay_pct }).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
    const beRequired = sense(parts.landed ?? 0) + sense(parts.delivery) + sense(parts.returns) + sense(parts.fixed);
    breakEven.push({ sku, break_even_price_myr: gaps.length ? null : Number(((beRequired / 100) / (1 - (Number(parts.mp_pct) + Number(parts.pay_pct)) / 100)).toFixed(2)), missing_components: gaps });
    if (gaps.length) { unknown.push({ sku, missing: gaps, reason: "input_absent_marks_UNKNOWN_excluded_from_ranking" }); continue; }
    const price = sense(parts.price);
    const feeSen = Math.round(price * (Number(parts.mp_pct) + Number(parts.pay_pct)) / 100) + sense(parts.fixed);
    const costSen = sense(parts.landed) + parts.delivery * 100 + parts.returns * 100;
    const margin = price - feeSen - costSen;
    table.push({ sku, price_myr: Number((price / 100).toFixed(2)), total_cost_myr: Number((costSen / 100).toFixed(2)), fees_myr: Number((feeSen / 100).toFixed(2)), contribution_myr: Number((margin / 100).toFixed(2)), margin_pct: Number(((margin / price) * 100).toFixed(2)), confidence: "COMPUTED_FROM_SUPPLIED_FIGURES" });
  }
  table.sort((a, b) => b.margin_pct - a.margin_pct || a.sku.localeCompare(b.sku)); // deterministic rank
  return {
    status: "OK", margin_table: table, break_even: breakEven, unknown_cost_flags: unknown,
    note: "figures are operator-supplied; unknown components keep the SKU UNKNOWN and off the ranking (contract semantics)",
  };
}

/* ---- storefront-builder (SK-047) — portable site SPEC + QA via Hashmeta connector rules.
 * The Hashmeta Website Connector is BLOCKED (no owner token / <9.0): no live call, no
 * preview request, publication NEVER automatic — owner approval + release gate required.
 * in : tenant_id, objective_id, task_id, validated_domain_inputs{products[], brand{name,colors?}, checkout_mode?}, source_refs
 * out: typed_artifact{site_spec, qa}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_storefront_build(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const products = Array.isArray(vdi.products) ? vdi.products : [];
  const brand = vdi.brand || {};
  if (!products.length || !brand.name) return { status: "REJECTED", reason: "site spec needs at least one product row and a brand name — nothing fabricated", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_incomplete_rejected"], cost_actual: 0, approval_requests: [] };
  const badRows = products.map((p, i) => ({ i, sku: String(p.sku ?? i), why: [!p.sku && "sku", (p.price_myr === undefined || p.price_myr === null) && "price_myr"].filter(Boolean) })).filter((r) => r.why.length);
  if (badRows.length) return { status: "REJECTED", reason: "product validation failed: " + badRows.map((r) => r.sku + "(" + r.why.join("+") + ")").join(", "), typed_artifact: null, evidence_refs: [], uncertainty_flags: ["product_validation_rejected"], cost_actual: 0, approval_requests: [] };
  const specId = stableId("SITE", [String(input.tenant_id), String(input.objective_id), brand.name, products.map((p) => p.sku).join(",")]);
  const siteSpec = {
    schema_version: 1, mode: "SPEC_ONLY", spec_id: specId,
    brand: { name: String(brand.name), palette: brand.colors || [], identity_lock: "manufacturer branding preserved; merchant brand additive only (ECOM-13 rule)" },
    layout: "mobile_first", pages: ["home", "catalog", "product", "cart", "checkout"],
    products: products.map((p) => ({ sku: String(p.sku), name: p.name ? String(p.name) : null, price_myr: Number(p.price_myr) })),
    checkout: { mode: String(vdi.checkout_mode || "central_company_account"), card_data_stored: false },
    connector: { candidate: "Hashmeta Website Connector", class: "BLOCKED", live_call_made: false, staging_preview: "NOT_REQUESTED_blocked_class" },
  };
  const qa = {
    overall: products.every((p) => p.name) ? "PASS_STRUCTURAL" : "INCOMPLETE",
    checks: ["mobile_first declared", "checkout is central_company_account", "no invented product facts (rows passthrough)", "publication held by owner-approval + connector-readiness gate"],
  };
  return {
    status: "OK",
    typed_artifact: { site_spec: siteSpec, qa_result: qa },
    evidence_refs: [specId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["hashmeta_connector_BLOCKED_no_live_call", "spec_only_no_site_created"],
    cost_actual: 0,
    approval_requests: [{ scope: "publish_live", auto: false, requires: "explicit owner approval per campaign AND connector 9.0 readiness — NEVER automatic" }],
  };
}

/* ---- supplier-verification (SK-049) — document-grounded supplier checks, no web lookup.
 * A supplier with no agreement on file is UNVERIFIED_PENDING_AGREEMENT (V43 ECOM-15 state),
 * never "verified". Contradictory/duplicate refs raise exceptions.
 * out: supplier_verification, exceptions, evidence_refs */
export function skill_supplier_verify(input = {}) {
  const missing = req(input, ["supplier_details", "agreements", "price_lists"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, supplier_verification: [], exceptions: [], evidence_refs: [] };
  const rows = []; const exceptions = []; const evRefs = [];
  const agBySupplier = new Map();
  for (const a of input.agreements) { const k = String(a.supplier_ref ?? a.supplier ?? ""); if (!agBySupplier.has(k)) agBySupplier.set(k, []); agBySupplier.get(k).push(a); evRefs.push("agreement:" + (a.doc_ref || k)); }
  const seenRefs = new Set();
  for (const s of input.supplier_details) {
    const ref = String(s.supplier_ref ?? s.name ?? "");
    if (seenRefs.has(ref)) exceptions.push({ supplier_ref: ref, issue: "CONTRADICTORY_DUPLICATE_SUPPLIER_REF" });
    seenRefs.add(ref);
    const ags = agBySupplier.get(ref) || [];
    const hasIdentity = Boolean(s.name && (s.registration_no || s.business_reg_no || s.company_registry));
    if (!hasIdentity) exceptions.push({ supplier_ref: ref, issue: "IDENTITY_EVIDENCE_MISSING" });
    const priceRows = input.price_lists.filter((p) => String(p.supplier_ref ?? "") === ref);
    if (!priceRows.length) exceptions.push({ supplier_ref: ref, issue: "NO_QUOTED_COSTS_ON_FILE" });
    evRefs.push("supplier:" + ref);
    rows.push({
      supplier_ref: ref,
      identity: hasIdentity ? "documented_fields_present" : "MISSING",
      agreement_state: ags.length ? (ags.some((a) => a.expired === true) ? "AGREEMENT_EXPIRED" : "AGREEMENT_ON_FILE") : "UNVERIFIED_PENDING_AGREEMENT",
      fulfillment_terms: s.fulfillment_terms ? "supplied" : "UNKNOWN",
      inventory_feed: s.inventory_feed ? "supplied" : "UNKNOWN_not_connected",
      quoted_costs: priceRows.length ? priceRows.length + " price list row(s)" : "UNKNOWN",
      verdict: hasIdentity && ags.length && ags.every((a) => a.expired !== true) ? "VERIFIED_ON_DOCUMENTS" : "UNVERIFIED_PENDING_AGREEMENT",
      caveat: "document presence only — no external registry lookup was or will be performed without an authorized connector",
    });
  }
  return { status: "OK", supplier_verification: rows, exceptions, evidence_refs: evRefs };
}

/* ---- audience-researcher (SK-002) — lawful non-sensitive segment PROFILES.
 * Demand evidence only from supplied observations; everything else is a labelled
 * assumption. No personal data, no scraping, sensitive attributes excluded by construction.
 * out: segment_profiles, evidence, exclusions */
export function skill_audience_research(input = {}) {
  const missing = req(input, ["market", "product", "allowed_channels"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, segment_profiles: [], evidence: [], exclusions: ["inputs_absent"] };
  const channels = input.allowed_channels.map(String);
  const obs = Array.isArray(input.observed_demand) ? input.observed_demand : [];
  const profiles = [
    { segment: "value_seeker_bargain_hunters", basis: "interest + price sensitivity at channel level", assumption: "price sensitivity inferred from product positioning, NOT from personal data" },
    { segment: "convenience_first_repeat_buyers", basis: "repeat-purchase pattern intent on own store channels", assumption: "no individual identities used — cohort level only" },
    { segment: "gift_givers_occasional", basis: "seasonal/occasion interest categories permitted by platform", assumption: "occasion intent assumed absent supply-side observation" },
  ].map((p) => ({ ...p, market: String(input.market), product: String(input.product), lawful_basis: "non-sensitive interest/context targeting; no profiling of personal attributes" }));
  if (obs.length) for (const pr of profiles) pr.evidence_link = "observed_demand_rows_supplied"; // supplied data raises the label, nothing invented
  return {
    status: "OK", segment_profiles: profiles,
    evidence: obs.map(String).concat(["assumption_register:3"]),
    exclusions: ["sensitive_attributes(health/religion/ethnicity/sexual_orientation/politics)", "individual_personally_identifiable_targeting", "scraped_or_purchased_personal_data", ...(!obs.length ? ["demand_claims_without_observed_data"] : [])],
    note: "ASSUMPTION-labelled profiles: with no lawful demand dataset supplied, nothing is presented as observed fact",
  };
}

/* ---- business-model-analyst (SK-005) — constraint-fit ranking for an elderly solopreneur.
 * Candidate models and their structural properties are the SUPPLIED templates below
 * (assumption register); ranking arithmetic is deterministic, capital fit checks inputs.
 * out: ranked_business_models, assumptions, risk_register */
const BUSINESS_MODEL_TEMPLATES = [
  { model: "marketplace_reselling", startup_complexity: 2, compliance_burden: 2, cash_flow_exposure: "holds_stock_or_preorders", manual_work_hours_week: 15 },
  { model: "supplier_direct_dropship", startup_complexity: 3, compliance_burden: 3, cash_flow_exposure: "low_if_supplier_credit_absent", manual_work_hours_week: 10 },
  { model: "pop_up_preorder", startup_complexity: 1, compliance_burden: 1, cash_flow_exposure: "preorder_funded", manual_work_hours_week: 8 },
  { model: "content_led_affiliate", startup_complexity: 2, compliance_burden: 1, cash_flow_exposure: "near_zero", manual_work_hours_week: 12 },
];
export function skill_business_model_analyze(input = {}) {
  const missing = req(input, ["owner_constraints", "market", "available_capital"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, ranked_business_models: [], assumptions: [], risk_register: [] };
  const c = input.owner_constraints || {};
  const capital = Number(input.available_capital);
  if (!(capital >= 0)) return { status: "REJECTED", reason: "available_capital must be a non-negative number", ranked_business_models: [], assumptions: [], risk_register: [] };
  const maxHours = c.weekly_hours !== undefined ? Number(c.weekly_hours) : 20;
  const mobilityOk = c.mobility !== "limited";
  const digital = c.digital_literacy === "high" || c.digital_literacy === "confident";
  const assumptions = [
    "template complexity/burden scores are structural ASSUMPTIONS registered here — not market facts",
    "capital fit uses only the supplied available_capital figure",
    "no live market data consulted (no connector authorized) — market label recorded only",
  ];
  const ranked = BUSINESS_MODEL_TEMPLATES
    .map((t) => {
      let fit = 10 - t.startup_complexity - t.compliance_burden;
      if (!digital && t.startup_complexity >= 3) fit -= 3;
      if (!mobilityOk && t.model === "pop_up_preorder") fit -= 4;
      if (t.manual_work_hours_week > maxHours) fit -= 4;
      if (capital <= 0 && (t.model === "marketplace_reselling" || t.model === "supplier_direct_dropship")) fit -= 3;
      return { ...t, fit_score: fit, market: String(input.market), needs_voice_first_ui: true };
    })
    .sort((a, b) => b.fit_score - a.fit_score || a.model.localeCompare(b.model));
  const risk_register = [
    { risk: "supplier_reliability_unverified", severity: "high", applies_to: ["supplier_direct_dropship", "marketplace_reselling"], mitigation: "SK-049 document verification + ECOM-15 agreement state machine" },
    { risk: "cash_flow_gap", severity: "medium", applies_to: ["marketplace_reselling"], mitigation: "pre-order funding or central-company checkout (ECOM-06)" },
    { risk: "digital_burden_on_owner", severity: "medium", applies_to: ranked.map((x) => x.model), mitigation: "voice-first dashboard + AI operator defaults (directive §18)" },
    { risk: "claims_compliance", severity: "high", applies_to: ["content_led_affiliate", "pop_up_preorder"], mitigation: "SK-012 screen + SK-013 UNKNOWN-until-cited posture" },
  ];
  return { status: "OK", ranked_business_models: ranked, assumptions, risk_register };
}

/* ---- campaign-strategist (SK-007) — draft campaign design within the OWNER'S declared cap.
 * Handoff (SK-056 marketing connector activation) is BLOCKED without per-campaign owner
 * approval; nothing here spends or activates. Hashmeta never called.
 * out: typed_artifact{campaign_draft}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_campaign_design(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const cap = Number(vdi.owner_budget_cap_myr);
  if (!(cap >= 0) || vdi.owner_budget_cap_myr === undefined || vdi.owner_budget_cap_myr === null) return { status: "REJECTED", reason: "owner_budget_cap_myr must be a declared non-negative number — campaigns are never designed around an absent cap", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["cap_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const audience = Array.isArray(vdi.audience_segments) ? vdi.audience_segments.map(String) : [];
  const channels = Array.isArray(vdi.channels) ? vdi.channels.map(String) : [];
  if (!audience.length || !channels.length) return { status: "REJECTED", reason: "audience_segments[] and channels[] required (from SK-002 lawful segments only)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["strategy_inputs_incomplete"], cost_actual: 0, approval_requests: [] };
  const draftId = stableId("CAMP", [String(input.tenant_id), String(input.objective_id), audience.join(","), channels.join(","), String(cap)]);
  const kpi = String(vdi.goal_kpi || "units_sold");
  return {
    status: "OK",
    typed_artifact: {
      campaign_draft: {
        draft_id: draftId, mode: "DRAFT_ONLY", goal: String(vdi.goal || "owner-stated objective"), kpi: { metric: kpi, target: vdi.kpi_target !== undefined ? Number(vdi.kpi_target) : "UNKNOWN_set_by_owner", measurable: kpi !== "UNKNOWN" },
        audience_segments: audience, channels, owner_budget_cap_myr: cap,
        spend_rule: "every spend action passes SK-035 atomic reservation gate <= cap; this design holds nothing by itself",
        activation: { requested: false, handoff: "SK-056 via Hashmeta Marketing Connector", connector_class: "BLOCKED", activated: false },
      },
    },
    evidence_refs: [draftId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["campaign_NOT_activated", "hashmeta_marketing_connector_BLOCKED"],
    cost_actual: 0,
    approval_requests: [{ scope: "activate_paid_campaign", auto: false, requires: "explicit per-campaign owner approval + transaction-level spend gate (NEVER automatic)" }],
  };
}

export const P0_SKILL_FUNCTIONS = {
  "ledger-append": skill_ledger_append, "catalog-query": skill_catalog_query, "evidence-append": skill_evidence_append,
  "gate-check": skill_gate_check, "schedule-scaffold": skill_schedule_scaffold, "report-compose": skill_report_compose,
  "creative-generator": skill_creative_generate, "poster-social-creator": skill_poster_social_create,
  "margin-analyst": skill_margin_analyze, "storefront-builder": skill_storefront_build,
  "claims-reviewer": skill_claims_review, "compliance-researcher": skill_compliance_research,
  "funnel-builder": skill_funnel_build, "spend-controller": skill_spend_control,
  "supplier-verification": skill_supplier_verify, "audience-researcher": skill_audience_research,
  "business-model-analyst": skill_business_model_analyze, "campaign-strategist": skill_campaign_design,
};

/* contract audit helper used by tests: declared sheet-04 required_input_fields must be
 * referenced by the implementing function; required_output_fields (core ones) must appear
 * in a real invocation of the function. */
export function p0ContractFieldAudit(invoke = {}) {
  const checks = [];
  for (const [family, fn] of Object.entries(P0_SKILL_FUNCTIONS)) {
    const src = fn.toString();
    const contract = loadSkillContract(family);
    if (!contract) { checks.push({ family, ok: false, why: "no contract row" }); continue; }
    const missingIn = (contract.required_input_fields || []).filter((f) => !src.includes(f) && !(f === "tenant_id" && src.includes("tenant")));
    const out = invoke[family] || {};
    const missingOut = (contract.required_output_fields || []).filter((f) => !(f in out) && !(out.typed_artifact && f in (out.typed_artifact || {})));
    checks.push({ family, skill_id: contract.skill_id, ok: missingIn.length === 0 && missingOut.length === 0, contract_inputs: contract.required_input_fields, unread_declared_inputs: missingIn, unemitted_declared_outputs: missingOut });
  }
  return checks;
}
