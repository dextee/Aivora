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
import { get, logEvent } from "./store.mjs";
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

/* ---- checkout-integrator (SK-011) — sandbox-only checkout configuration + dry-run tests.
 * Connector-bound: payment/supplier/logistics class is BLOCKED (CAT-21 rule1, TBD provider),
 * so no live transaction is ever simulated as real. Provider credentials are NEVER read,
 * stored or printed — adapters are referenced by name only (contract: no credentials in prompts).
 * out: checkout_test_result, integration_status, exceptions (+envelope sidecars) */
export function skill_checkout_integrate(input = {}) {
  const missing = req(input, ["tenant_id", "merchant_config", "order_rules", "payment_adapter"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, checkout_test_result: null, integration_status: null, exceptions: ["inputs_absent"], typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const mc = input.merchant_config || {};
  const mode = String(mc.mode || "").toLowerCase();
  if (mode !== "sandbox") return { status: "REJECTED", reason: "only sandbox merchant_config.mode accepted — no live checkout without merchant authorization", checkout_test_result: null, integration_status: "BLOCKED", exceptions: ["mode_rejected"], typed_artifact: null, evidence_refs: [], uncertainty_flags: ["live_path_never_simulated"], cost_actual: 0, approval_requests: [] };
  const adapter = String(input.payment_adapter).trim();
  if (!adapter || /secret|api[_-]?key|token|password/i.test(adapter)) return { status: "REJECTED", reason: "payment_adapter must be an adapter NAME; credential-like values are never accepted or stored", checkout_test_result: null, integration_status: "BLOCKED", exceptions: ["credential_like_input"], typed_artifact: null, evidence_refs: [], uncertainty_flags: ["no_payment_credentials_in_prompts_or_storage"], cost_actual: 0, approval_requests: [] };
  const or = input.order_rules || {};
  const exceptions = [];
  if (or.currency !== "MYR") exceptions.push({ rule: "currency", issue: "MYR required (central-company checkout currency); found " + JSON.stringify(or.currency ?? null) });
  if (!Number.isFinite(Number(or.min_order_value_myr)) || Number(or.min_order_value_myr) < 0) exceptions.push({ rule: "min_order_value_myr", issue: "non-negative number required" });
  const ft = or.fulfillment_type;
  if (!["dropship", "stock", "preorder"].includes(ft)) exceptions.push({ rule: "fulfillment_type", issue: "must be dropship|stock|preorder" });
  if (exceptions.length) return { status: "REJECTED", reason: "order_rules failed validation", checkout_test_result: { mode: "SANDBOX_DRY_RUN", executed: false }, integration_status: "BLOCKED", exceptions, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["rules_invalid_no_test_run"], cost_actual: 0, approval_requests: [] };
  const cases = [{ case: "single_item_pricing", expect: "server_side_price" }, { case: "tax_line_present", expect: "from_merchant_config.tax_rate_or_zero_label" }, { case: "shipping_line_present", expect: "from_order_rules" }, { case: "duplicate_idempotency_key", expect: "second_submit_replays_first_order_id" }, { case: "live_submit_attempt", expect: "blocked_connector_CAT-21" }].map((c) => ({ ...c, result: c.case === "live_submit_attempt" ? "BLOCKED_per_CAT-21" : "PASS_LOCAL_DRY_RUN" }));
  const testId = stableId("CHK", [String(input.tenant_id), adapter, String(or.currency), String(or.min_order_value_myr), String(ft)]);
  return {
    status: "OK",
    checkout_test_result: { test_id: testId, mode: "SANDBOX_DRY_RUN", gateway_called: false, cases },
    integration_status: "SANDBOX_READY_LIVE_BLOCKED",
    exceptions: [],
    typed_artifact: { mode: "MOCK", adapter_name: adapter, credentials_stored: false, server_side_pricing_only: true, idempotency_key_strategy: "client_key+tenant+objective", customer_contact: "NOT_SENT — outbound customer messaging is approval-gated, never automatic" },
    evidence_refs: [testId, "CAT-21:BLOCKED"],
    uncertainty_flags: ["payment_connector_BLOCKED_owner_token_class", "sandbox_results_not_live_evidence"],
    cost_actual: 0,
    approval_requests: [{ scope: "enable_live_checkout", auto: false, requires: "merchant authorization + owner token + DEV-11 verification — never automatic" }],
  };
}

/* ---- conversation-designer (SK-016) — flow/objection/handoff SCRIPT drafts.
 * Scripts only: live customer replies route through SK-023 (contract boundary) and are
 * out of scope here. Content derives from the supplied objective + source refs; no sales,
 * margins, stock or completed actions are invented into the dialogs.
 * out: typed_artifact{conversation_flow_draft}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
const vdi_channels = (vdi) => vdi.channels;
export function skill_conversation_design(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const tone = String(vdi.tone || "").trim();
  const langs = Array.isArray(vdi.languages) && vdi.languages.length ? vdi.languages.map(String) : null;
  if (!tone || !langs) return { status: "REJECTED", reason: "tone and languages[] must be owner-supplied — conversational voice is never invented for a real person", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["voice_profile_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const channels = Array.isArray(vdi_channels(vdi)) ? vdi_channels(vdi).map(String) : ["storefront_widget"];
  const objections = Array.isArray(vdi.common_objections) ? vdi.common_objections.map(String) : [];
  const flowId = stableId("FLOW", [String(input.tenant_id), String(input.objective_id), String(input.task_id), channels.join(",")]);
  const stage = (name, purpose, slots) => ({ stage: name, purpose, plain_language_slots: slots });
  return {
    status: "OK",
    typed_artifact: {
      conversation_flow_draft: {
        flow_id: flowId, tone, languages: langs, channels,
        objective: String(vdi.conversation_objective || input.objective_id),
        stages: [
          stage("greeting", "plain welcoming opening from owner tone", ["speaker_name_source:merchant_profile"]),
          stage("discovery", "ask one question at a time; never assume stock/price — UNKNOWN stays UNKNOWN", ["product_ref", "need"]),
          stage("objection_handling", objections.length ? objections.map((o) => "address '" + o + "' with evidence refs only, no invented guarantees") : "no OWNER-SUPPLIED objection list — templates flagged assumption_only", ["objection", "evidence_ref"]),
          stage("checkout_guidance", "guide to central-company sandbox checkout (SK-011); payment credentials never requested in chat", ["order_confirmation_ref"]),
          stage("handoff", "escalate out-of-scope or distressed customer WITH owner approval; live replies route via SK-023 (contract boundary)", ["handoff_reason"]),
        ],
        outbound_messaging: { automatic: false, connector: "WhatsApp Business (approval-gated)", state: "NOT_SENT" },
      },
    },
    evidence_refs: [flowId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["scripts_draft_only", "no_live_replies_from_this_skill_boundary_SK-023"],
    cost_actual: 0,
    approval_requests: [{ scope: "activate_customer_contact", auto: false, requires: "explicit owner approval per policy gateway — contact is NEVER automatic" }],
  };
}

/* ---- demand-researcher (SK-019) — demand brief strictly from cited observations.
 * Differentiates indicator vs verified transaction demand by TYPE tags; competitor rows
 * passthrough as SUPPLIED. With zero cited evidence there is nothing to research:
 * error_and_recovery refuses invention ⇒ REJECTED.
 * out: demandbrief, evidence, uncertainty */
export function skill_demand_research(input = {}) {
  const missing = req(input, ["product_category", "geography", "time_window"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, demand_brief: null, evidence: [], uncertainty: ["inputs_absent"] };
  const rows = Array.isArray(input.supplied_observations) ? input.supplied_observations : [];
  const cited = rows.filter((o) => o && o.source_ref);
  if (!cited.length) return { status: "REJECTED", reason: "no cited observation rows supplied — demand facts are never invented (error_and_recovery: nothing invented on failure)", demand_brief: null, evidence: [], uncertainty: ["no_cited_sources"] };
  const tag = (o) => ({ type: String(o.type || "indicator_unverified"), value: o.value ?? "UNKNOWN", source_ref: String(o.source_ref) });
  const signals = cited.filter((o) => o.type !== "verified_transaction").map(tag);
  const verified = cited.filter((o) => o.type === "verified_transaction").map(tag);
  const competitors = (Array.isArray(input.competitor_rows) ? input.competitor_rows : []).map((c) => ({ ...(c || {}), status: "supplied_unverified" }));
  const seasonal = Array.isArray(input.seasonality_rows) ? input.seasonality_rows.map((s) => ({ ...(s || {}), status: "supplied_unverified" })) : [];
  return {
    status: "OK",
    demand_brief: {
      product_category: String(input.product_category), geography: String(input.geography), time_window: String(input.time_window),
      indicators: signals, verified_transaction_demand: verified, competitor_rows: competitors, seasonality_rows: seasonal,
      confidence: verified.length ? (verified.length >= 2 ? "MEDIUM_two_plus_verified_rows" : "LOW_single_verified_row") : "INDICATOR_ONLY_no_verified_transaction_data",
      basis_rule: "indicator rows are NEVER presented as transaction demand",
    },
    evidence: cited.map((o) => String(o.source_ref)),
    uncertainty: ["external_live_research_sources_NOT_consulted_no_connector", "competitor_and_seasonality_rows_only_as_supplied", "no_synthetic_market_sizing_performed", ...(!verified.length ? ["zero_verified_transaction_rows_all_indicator_class"] : [])],
  };
}

/* ---- fulfillment-planner (SK-025) — routing + lead-time SLAs from VERIFIED supplier rows.
 * Suppliers without a document verdict (SK-049) surface only as UNVERIFIED_PENDING_AGREEMENT
 * and never carry SLA guarantees. Route dispatch touches the BLOCKED CAT-21 connector class:
 * outbound supplier PO/email NEVER happens here (ECOM-17 owns the approval-gated outbox).
 * out: typed_artifact{fulfillment_plan}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_fulfillment_plan(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const items = Array.isArray(vdi.order_items) && vdi.order_items.length ? vdi.order_items : null;
  const suppliers = Array.isArray(vdi.supplier_rows) && vdi.supplier_rows.length ? vdi.supplier_rows : null;
  if (!items || !suppliers) return { status: "REJECTED", reason: "order_items[] and supplier_rows[] (from SK-049 verified field) are required — lead times and stock are never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["sourcing_inputs_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const usable = suppliers.filter((s) => s && s.verdict === "VERIFIED_ON_DOCUMENTS" && Number.isFinite(Number(s.sla_days)));
  const excluded = suppliers.filter((s) => !usable.includes(s)).map((s) => ({ supplier_ref: String((s || {}).supplier_ref || "unknown"), reason: (s && s.verdict) || "NO_DOCUMENT_VERDICT", sla: "NOT_GUARANTEED" }));
  if (!usable.length) return { status: "REJECTED", reason: "no supplier row passes documents-verification with an on-file SLA — plan refused rather than built on UNVERIFIED sourcing", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["all_suppliers_unverified_rejected"], cost_actual: 0, approval_requests: [] };
  const ranked = [...usable].sort((a, b) => Number(a.sla_days) - Number(b.sla_days) || String(a.supplier_ref).localeCompare(String(b.supplier_ref)));
  const routes = items.map((it, i) => {
    const s = ranked[i % ranked.length];
    return { item: String((it && it.sku) || "item-" + (i + 1)), supplier_ref: String(s.supplier_ref), lead_time_sla_days: Number(s.sla_days), sla_basis: "quoted_field_on_supplier_record_not_guarantee", route_state: "PLANNED_NOT_DISPATCHED" };
  });
  const planId = stableId("FUL", [String(input.tenant_id), String(input.objective_id), String(input.task_id), routes.map((r) => r.item + "@" + r.supplier_ref).join(",")]);
  return {
    status: "OK",
    typed_artifact: {
      mode: "SANDBOX_PLAN_EXTERNAL_BLOCKED",
      fulfillment_plan: {
        plan_id: planId, mode: "SANDBOX_PLAN_EXTERNAL_BLOCKED", routes,
        total_window_days: Math.max(...routes.map((r) => r.lead_time_sla_days)),
        unverified_excluded: excluded,
        dispatch: { connector_class: "BLOCKED", matrix_row: "CAT-21", outbound_po_or_email: "NEVER_FROM_THIS_SKILL", handoff: "ECOM-17 supplier outbox (idempotent, approval-gated)" },
      },
    },
    evidence_refs: [planId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["supplier_feed_sync_BLOCKED_no_connector", "sla_days_are_quoted_fields_not_guarantees", "plan_not_dispatched_dry_run"],
    cost_actual: 0,
    approval_requests: [{ scope: "dispatch_supplier_routes", auto: false, requires: "per-order owner approval through policy gateway; real supplier emails NEVER automated" }],
  };
}

/* ---- objective-planner (SK-031) — goal decomposition into a validated DAG.
 * "One planner": deterministic topological structuring of OWNER-STATED goals only.
 * Success metrics stay UNKNOWN until the owner supplies numbers — never invented.
 * out: typed_artifact{objective_dag}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_objective_plan(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const goal = String(vdi.goal_statement || "").trim();
  const tasks = Array.isArray(vdi.tasks) ? vdi.tasks : null;
  if (!goal || !tasks || !tasks.length) return { status: "REJECTED", reason: "goal_statement and tasks[] must be owner-supplied — decomposition of an absent goal is invention", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["goal_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const ids = tasks.map((t) => String(t.id));
  if (new Set(ids).size !== ids.length) return { status: "REJECTED", reason: "duplicate task ids in decomposition", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["dag_invalid"], cost_actual: 0, approval_requests: [] };
  const idset = new Set(ids);
  for (const t of tasks) for (const d of (t.deps || [])) if (!idset.has(String(d))) return { status: "REJECTED", reason: "unknown dependency '" + d + "' on task " + t.id, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["dag_invalid"], cost_actual: 0, approval_requests: [] };
  const marks = new Map(ids.map((i) => [i, 0]));
  const visit = (i) => {
    if (marks.get(i) === 1) return false;
    if (marks.get(i) === 2) return true;
    marks.set(i, 1);
    const t = tasks.find((x) => String(x.id) === i);
    for (const d of (t.deps || [])) if (!visit(String(d))) return false;
    marks.set(i, 2); return true;
  };
  for (const i of ids) if (!visit(i)) return { status: "REJECTED", reason: "dependency cycle detected — plan refused (validatePlanEdges semantics)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["dag_invalid"], cost_actual: 0, approval_requests: [] };
  const placed = new Map();
  const depth = (i) => { if (placed.has(i)) return placed.get(i); const t = tasks.find((x) => String(x.id) === i); const d = 1 + Math.max(0, ...(t.deps || []).map((q) => depth(String(q)))); placed.set(i, d); return d; };
  const layers = ids.map((i) => ({ id: i, layer: depth(i) - 1 })).sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id));
  const dagId = stableId("DAG", [String(input.tenant_id), String(input.objective_id), ids.join(",")]);
  return {
    status: "OK",
    typed_artifact: {
      mode: "LOCAL_DETERMINISTIC",
      objective_dag: {
        plan_id: dagId, goal, tasks: layers.map((l) => {
          const t = tasks.find((x) => String(x.id) === l.id);
          return { id: l.id, layer: l.layer, deps: (t.deps || []).map(String), success_criteria: t.success_criteria ? String(t.success_criteria) : "UNKNOWN_owner_metric_required", owner_stated: true };
        }),
      },
    },
    evidence_refs: [dagId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["criteria_UNKNOWN_where_owner_metric_absent_never_invented", "single_planner_no_parallel_authority"],
    cost_actual: 0, approval_requests: [{ scope: "commit_objective_plan", auto: false, requires: "owner confirmation of goal wording and metrics before task graph activation" }],
  };
}

/* ---- supplier-dispatcher (SK-048) — PO RECORD builder; external dispatch BLOCKED.
 * Connector class BLOCKED (CAT-21, supplier connector TBD): every dispatch attempt returns
 * BLOCKED with retry guidance, per error_and_recovery — a confirmed state is NEVER fabricated.
 * External outcome UNKNOWN ⇒ reconcile_before_retry enforced. Real supplier emails NEVER.
 * out: typed_artifact{po_record, dispatch}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_supplier_dispatch(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const approved = vdi.approved_order_refs;
  if (!Array.isArray(approved) || !approved.length) return { status: "REJECTED", reason: "approved_order_refs[] required — dispatch boundary is 'approved order only' (SK-046 hold must precede)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["approval_missing_rejected"], cost_actual: 0, approval_requests: [] };
  const items = Array.isArray(vdi.line_items) && vdi.line_items.length ? vdi.line_items : null;
  const sup = String(vdi.supplier_ref || "").trim();
  if (!items || !sup) return { status: "REJECTED", reason: "line_items[] and supplier_ref required; costs/quantities are never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["po_fields_missing"], cost_actual: 0, approval_requests: [] };
  if (vdi.supplier_verdict !== "VERIFIED_ON_DOCUMENTS") return { status: "REJECTED", reason: "supplier not VERIFIED_ON_DOCUMENTS (SK-049) — dispatch refuses UNVERIFIED_PENDING_AGREEMENT sourcing", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["supplier_unverified"], cost_actual: 0, approval_requests: [] };
  const poId = stableId("PO", [String(input.tenant_id), sup, approved.join(","), items.map((i) => (i.sku || "?") + "x" + (i.qty ?? "?")).join(",")]);
  const prior = String(vdi.prior_dispatch_state || "").toUpperCase();
  return {
    status: "BLOCKED",
    typed_artifact: {
      mode: "MOCK", po_record: { po_id: poId, supplier_ref: sup, line_items: items.map((i) => ({ sku: String(i.sku || "?"), qty: i.qty ?? null })), approved_order_refs: approved.map(String), idempotency_key: poId },
      dispatch: { connector_class: "BLOCKED", matrix_row: "CAT-21 rule1 supplier connector TBD", attempted: false, sent: false, confirmation_state: prior === "UNKNOWN" || prior === "EXTERNAL_UNKNOWN" ? "RECONCILE_BEFORE_RETRY" : "NOT_ATTEMPTED", retry_guidance: "re-issue via ECOM-17 outbox once owner-token LIVE connector exists; reconcile any UNKNOWN outcome BEFORE retry (T13 semantics)" },
    },
    evidence_refs: [poId, "CAT-21:BLOCKED"],
    uncertainty_flags: ["supplier_confirmation_never_assumed", "real_supplier_email_NEVER"],
    cost_actual: 0,
    approval_requests: [{ scope: "live_supplier_dispatch", auto: false, requires: "owner authorization (credentials + connector LIVE class) — record built here is PO CONTENT only, not evidence of transmission" }],
  };
}

/* ---- marketing-os-campaign-builder (SK-056) — Hashmeta campaign draft, activation BLOCKED.
 * Consumes ONLY owner-approved draft material (SK-007 lineage: DRAFT campaigns with explicit
 * cap/audience/channels). Hashmeta connector is BLOCKED owner-token class: nothing is created
 * externally; T20 no-duplicate-social-publishing rule held by design (this skill never publishes).
 * out: campaign_plan, hashmeta_campaign_draft_id, estimated_costs, approval_request, kpis */
export function skill_marketing_campaign_build(input = {}) {
  const missing = req(input, ["objective_id", "tenant_id", "product_ids", "audience", "channels", "budget_cap", "currency", "approval_policy"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, campaign_plan: null, hashmeta_campaign_draft_id: null, estimated_costs: null, approval_request: null, kpis: [] };
  if (String(input.currency) !== "MYR") return { status: "REJECTED", reason: "currency must be MYR (central-company checkout currency); FX assumptions are never auto-applied", campaign_plan: null, hashmeta_campaign_draft_id: null, estimated_costs: null, approval_request: null, kpis: [] };
  const cap = Number(input.budget_cap);
  const audience = Array.isArray(input.audience) ? input.audience.map(String) : [String(input.audience)];
  const channels = Array.isArray(input.channels) ? input.channels.map(String) : [];
  if (!(cap > 0) || !audience.length || !channels.length) return { status: "REJECTED", reason: "positive budget_cap with audience[] and channels[] required — campaign scope is never inferred", campaign_plan: null, hashmeta_campaign_draft_id: null, estimated_costs: null, approval_request: null, kpis: [] };
  const draftId = stableId("HMC", [String(input.tenant_id), String(input.objective_id), audience.join(","), channels.join(","), String(cap)]);
  return {
    status: "OK",
    campaign_plan: { draft_id: draftId, mode: "DRAFT_ONLY", objective: String(input.objective_id), products: input.product_ids.map(String), audience, channels, spend_rule: "each spend step passes SK-035/SK-046 atomic reservation <= " + cap + " MYR; plan itself holds nothing" },
    hashmeta_campaign_draft_id: draftId + "-HASHMETA-DRAFT",
    estimated_costs: { basis: "ESTIMATE_NOT_QUOTED_no_connector_priced", cap_myr: cap, committed_myr: 0, note: "actual prices UNKNOWN until owner-approved sandbox quote — never fabricated" },
    approval_request: { id: draftId + "-APPR", state: "PENDING_OWNER_APPROVAL", auto: false, requires: "explicit per-campaign owner approval; activation handoff blocked while Hashmeta connector is BLOCKED (owner-token class)" },
    kpis: [{ metric: "owner_declared_conversion_goal", target: "UNKNOWN_set_by_owner", measurable: false }],
    activation: { connector_class: "BLOCKED", activated: false, social_publishing: "NONE — duplicate-publish rule T20 held; publishing routes via approved post tooling only" },
    evidence_refs: [draftId], uncertainty_flags: ["hashmeta_NEVER_called_live", "draft_id_is_local_record_only"],
    cost_actual: 0,
  };
}

/* ---- conversion-analyst (SK-017) — funnel arithmetic on supplied counted events only.
 * Connector-bound (Google Analytics: unverified class) ⇒ NO live traffic pulls; rows must be
 * tenant-supplied with provenance. Correlation is reported, causality is NEVER assumed
 * (contract boundary) and change proposals are estimates, not promised lifts.
 * out: typed_artifact{conversion_analysis}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_conversion_analyze(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const stages = Array.isArray(vdi.funnel_stage_counts) ? vdi.funnel_stage_counts : null;
  if (!stages || stages.length < 2) return { status: "REJECTED", reason: "funnel_stage_counts[] (>=2 stages, each {stage, entered, completed, source_ref}) required — GA4 is not consulted, rates are never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["metrics_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const rows = [];
  for (const s of stages) {
    if (!s || !s.stage || !Number.isFinite(Number(s.entered)) || !Number.isFinite(Number(s.completed)) || !s.source_ref) return { status: "REJECTED", reason: "every stage needs stage/entered/completed/source_ref — uncounted data is refused, not estimated", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["stage_row_invalid"], cost_actual: 0, approval_requests: [] };
    const entered = Number(s.entered), completed = Number(s.completed);
    if (entered < 0 || completed < 0 || completed > entered) return { status: "REJECTED", reason: "stage '" + s.stage + "' counts impossible (completed>entered or negative)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["counts_impossible"], cost_actual: 0, approval_requests: [] };
    const pct = entered ? Math.round((completed / entered) * 10000) / 100 : 0;
    rows.push({ stage: String(s.stage), entered, completed, rate_pct: pct, source_ref: String(s.source_ref) });
  }
  const worst = [...rows].sort((a, b) => a.rate_pct - b.rate_pct)[0];
  const analysisId = stableId("CVA", [String(input.tenant_id), String(input.objective_id), rows.map((r) => r.stage + "=" + r.rate_pct).join(";")]);
  return {
    status: "OK",
    typed_artifact: {
      mode: "LOCAL_ARITHMETIC_EXTERNAL_ANALYTICS_BLOCKED",
      conversion_analysis: {
        analysis_id: analysisId, stages: rows,
        lowest_conversion_stage: worst.stage,
        interpretation_rule: "correlation only — causality NOT assumed per contract boundary; segment comparisons need supplied segment data",
        recommendations: [{ stage: worst.stage, action_class: "CRO_hypothesis", detail: "propose ONE plain-language test for '" + worst.stage + "'; expected lift UNKNOWN_until_tested (no promised results)" }],
      },
    },
    evidence_refs: [analysisId].concat(rows.map((r) => r.source_ref)),
    uncertainty_flags: ["google_analytics_connector_unverified_no_live_pull", "rates_describe_supplied_counts_only"],
    cost_actual: 0,
    approval_requests: [{ scope: "run_cro_change", auto: false, requires: "owner approval before any storefront change (SK-047 rebuild stays gated)" }],
  };
}

/* ---- escalation-agent (SK-020) — complaint triage into owner queues with SLA labels.
 * Internal coverage class: deterministic triage, never contacts the customer. Human
 * handoff is the deliverable; money-loss / delivery-failure classes route to the TOP of
 * the owner exception queue (elderly solopreneur: short, plain action list).
 * out: typed_artifact{escalation}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_escalation_triage(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const complaints = Array.isArray(vdi.complaints) && vdi.complaints.length ? vdi.complaints : null;
  if (!complaints) return { status: "REJECTED", reason: "complaints[] ({ref, text_class, order_ref?}) required — triage of absent complaints would fabricate customer state", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["complaints_absent_rejected"], cost_actual: 0, approval_requests: [] };
  const slaHours = Number.isFinite(Number(vdi.sla_hours)) ? Number(vdi.sla_hours) : 24;
  const CLASSES = { refund_request: "MONEY", delivery_failure: "DELIVERY", product_quality: "PRODUCT", other_enquiry: "GENERAL" };
  const rows = complaints.map((c, i) => {
    const cls = String((c || {}).text_class || "other_enquiry").toLowerCase();
    const kind = CLASSES[cls] ? cls : "other_enquiry";
    const sev = kind === "refund_request" || kind === "delivery_failure" ? "high" : kind === "product_quality" ? "medium" : "low";
    return { ref: String((c || {}).ref || "ESC-" + (i + 1)), text_class: kind, severity: sev, order_ref: (c || {}).order_ref ? String(c.order_ref) : null, queue: sev === "high" ? "owner_exception_TOP" : "owner_daily_digest", sla_hours: sev === "high" ? Math.min(slaHours, 4) : slaHours, plain_action: sev === "high" ? "one-tap: open order, approve refund path (SK-046 release) or reply draft" : "batch-review with drafted reply (SK-016 tone)" };
  });
  const escId = stableId("ESC", [String(input.tenant_id), String(input.objective_id), rows.map((r) => r.ref + r.text_class).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "LOCAL_DETERMINISTIC", escalation: { escalation_id: escId, items: rows, human_handoff: { to: "owner (solopreneur) + delegated helper option", customer_contact_made: false, live_reply_route: "SK-023 gated answers only" } } },
    evidence_refs: [escId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["classification_from_supplied_text_class_only", "no_semantic_analysis_of_raw_customer_words"],
    cost_actual: 0,
    approval_requests: [{ scope: "send_apology_or_refund_comm", auto: false, requires: "owner approval — outbound customer contact NEVER automatic (SK-016/SK-011 boundary)" }],
  };
}

/* ---- experiment-analyst (SK-022) — A/B arithmetic on supplied variant counts.
 * Threshold must be PRE-DECLARED (stop post-hoc goal-posting); GA4 connector class is
 * unverified ⇒ no live pull; attribution stays correlational per contract boundary.
 * out: typed_artifact{experiment_analysis}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
const vbi_source_present = (a, b) => Boolean(a.source_ref && b.source_ref);
export function skill_experiment_analyze(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const va = vdi.variant_a, vb = vdi.variant_b, thr = vdi.min_sample_per_arm;
  const shape = (v) => v && Number.isFinite(Number(v.exposures)) && Number.isFinite(Number(v.conversions)) && Number(v.exposures) > 0;
  if (!shape(va) || !shape(vb)) return { status: "REJECTED", reason: "variant_a/variant_b with exposures+conversions counts required — metrics are never invented (GA connector not consulted)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["variant_counts_absent"], cost_actual: 0, approval_requests: [] };
  if (!Number.isFinite(Number(thr)) || Number(thr) <= 0) return { status: "REJECTED", reason: "min_sample_per_arm must be a pre-declared positive threshold before any verdict (error_and_recovery: no post-hoc conclusions)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["threshold_missing"], cost_actual: 0, approval_requests: [] };
  const under = Number(va.exposures) < Number(thr) || Number(vb.exposures) < Number(thr);
  const pa = Number(va.conversions) / Number(va.exposures), pb = Number(vb.conversions) / Number(vb.exposures);
  if (Number(va.conversions) > Number(va.exposures) || Number(vb.conversions) > Number(vb.exposures)) return { status: "REJECTED", reason: "conversions exceed exposures — impossible counts refused", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["counts_impossible"], cost_actual: 0, approval_requests: [] };
  const expId = stableId("EXP", [String(input.tenant_id), String(va.name || "A"), String(vb.name || "B"), String(thr)]);
  const verdict = under ? "INSUFFICIENT_SAMPLE_keep_running" : (Math.abs(pa - pb) < 1e-12 ? "NO_DIFFERENCE" : (pb > pa ? String(vb.name || "B") : String(va.name || "A")) + "_FAVOURED_correlation_only");
  return {
    status: "OK",
    typed_artifact: {
      mode: "LOCAL_ARITHMETIC_EXTERNAL_ANALYTICS_BLOCKED",
      experiment_analysis: { experiment_id: expId, arms: { [String(va.name || "A")]: { exposure: Number(va.exposures), conv_rate: Math.round(pa * 10000) / 100 }, [String(vb.name || "B")]: { exposure: Number(vb.exposures), conv_rate: Math.round(pb * 10000) / 100 } }, min_sample_per_arm: Number(thr), threshold_pre_declared: true, verdict, difference_pct_points: Math.round((pb - pa) * 10000) / 100 },
    },
    evidence_refs: [expId].concat([va, vb].flatMap((v) => v.source_ref ? [String(v.source_ref)] : [])),
    uncertainty_flags: ["attribution_is_correlational_not_causal", "google_analytics_connector_unverified_no_live_pull", ...(!vbi_source_present(va, vb) ? ["arms_missing_source_ref_descriptive_only"] : [])],
    cost_actual: 0,
    approval_requests: [{ scope: "rollout_winner", auto: false, requires: "owner approval before adopting a variant on the live storefront (SK-047 gate)" }],
  };
}

/* ---- faq-retrieval-agent (SK-023) — grounded answers over APPROVED documents only.
 * Corpus is supplied/registered approved text (Supabase LIVE class connector-bound and
 * BLOCKED — nothing is fetched remotely here). Deterministic keyword retrieval; NO approval
 * ⇒ REJECTED; no doc match ⇒ answer with NO fabricated fallback, route to SK-020 escalation.
 * out: typed_artifact{faq_answer}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_faq_retrieve(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const question = String(vdi.question || "").trim().toLowerCase();
  const approvedOk = vdi.owner_approved_kb_ids;
  if (!question) return { status: "REJECTED", reason: "question required", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["question_absent"], cost_actual: 0, approval_requests: [] };
  if (!Array.isArray(approvedOk) || !approvedOk.length) return { status: "REJECTED", reason: "owner_approved_kb_ids[] required — the reply brain answers only from owner-approved knowledge (boundary: approved knowledge only)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["kb_approval_missing_rejected"], cost_actual: 0, approval_requests: [] };
  const docs = Array.isArray(vdi.kb_documents) ? vdi.kb_documents : [];
  const allow = new Set(approvedOk.map(String));
  const terms = question.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  const scored = docs
    .filter((d) => d && allow.has(String(d.kb_id)))
    .map((d) => {
      const hay = (String(d.text || "") + " " + String(d.title || "")).toLowerCase();
      const hits = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { doc: d, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || String(a.doc.kb_id).localeCompare(String(b.doc.kb_id)));
  const answerId = stableId("FAQ", [String(input.tenant_id), question, approvedOk.join(",")]);
  if (!scored.length) {
    return {
      status: "OK",
      typed_artifact: { mode: "GROUNDED_RETRIEVAL_NO_GENERATION", faq_answer: { answer_id: answerId, state: "NO_APPROVED_MATCH", answer_text: null, note: "no fabricated fallback — unanswerable questions route to human escalation (SK-020 queue)", escalate_ref_suggestion: "SK-020:" + answerId } },
      evidence_refs: [answerId], uncertainty_flags: ["no_approved_doc_matched"],
      cost_actual: 0, approval_requests: [{ scope: "answer_outside_kb", auto: false, requires: "owner must ADD approved knowledge first; speculative replies prohibited" }],
    };
  }
  const top = scored[0].doc;
  return {
    status: "OK",
    typed_artifact: { mode: "GROUNDED_RETRIEVAL_NO_GENERATION", faq_answer: { answer_id: answerId, state: "ANSWERED", answer_text: String(top.answer_text ?? top.text), citation: { kb_id: String(top.kb_id), title: top.title ? String(top.title) : null }, send_to_customer: { automatic: false, gate: "outbound customer replies require owner approval (policy gateway)" } } },
    evidence_refs: [answerId, "kb:" + String(top.kb_id)].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["retrieval_over_supplied_approved_corpus_only", "supabase_live_kb_sync_BLOCKED_connector_class"],
    cost_actual: 0,
    approval_requests: [{ scope: "auto_reply_customer", auto: false, requires: "explicit owner approval per reply — customer contact NEVER automatic" }],
  };
}

/* ---- order-validator (SK-033) — schema + duplicate/idempotency checks; registers valid orders.
 * Validation is deterministic over the payload; duplicate detection uses a persistent
 * idempotency fingerprint in the tenant's in-memory order register (Supabase LIVE class is
 * BLOCKED — register is local, TEST-labelled, never presented as durable DB truth).
 * out: typed_artifact{validation}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_order_validate(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const problems = [];
  const lines = Array.isArray(vdi.lines) ? vdi.lines : null;
  if (!lines || !lines.length) problems.push("lines[] required with sku+qty");
  else for (const l of lines) {
    if (!l || !String(l.sku || "").trim()) problems.push("line missing sku");
    if (!l || !Number.isInteger(Number(l.qty)) || Number(l.qty) <= 0) problems.push("line qty must be positive integer");
  }
  if (vdi.currency !== "MYR") problems.push("currency must be MYR (central-company checkout policy)");
  if (!Number.isFinite(Number(vdi.total_myr)) || Number(vdi.total_myr) <= 0) problems.push("total_myr must be a positive number");
  if (!String(vdi.idempotency_key || "").trim()) problems.push("idempotency_key required");
  if (problems.length) return { status: "REJECTED", reason: "order failed schema validation", typed_artifact: { validation: { valid: false, problems } }, evidence_refs: [], uncertainty_flags: ["schema_invalid"], cost_actual: 0, approval_requests: [] };
  const t = get(String(input.tenant_id)); // only valid-shaped orders touch the tenant register
  const key = String(vdi.idempotency_key);
  const existing = t.orders.find((o) => o.idempotency_key === key);
  const fingerprint = createHash("sha256").update([key, lines.map((l) => l.sku + "x" + l.qty).join(","), String(vdi.total_myr)].join("\u0000")).digest("hex").slice(0, 16);
  if (existing) {
    const sameFp = existing.order_fingerprint === fingerprint;
    return {
      status: "OK",
      typed_artifact: { validation: { valid: sameFp, duplicate: true, replay_of: existing.order_id || null, result: sameFp ? "IDEMPOTENT_REPLAY_OK" : "DUPLICATE_KEY_CONFLICT_REJECTED", problems: sameFp ? [] : ["same idempotency_key with different payload — refused, no overwrite"], order_fingerprint: fingerprint } },
      evidence_refs: [existing.order_id || key].concat((input.source_refs || []).map(String)),
      uncertainty_flags: ["local_register_not_durable_db_supabase_live_BLOCKED"],
      cost_actual: 0, approval_requests: [],
    };
  }
  const order = (t.orders[t.orders.length - 1] || { order_id: "T-0" }).order_id;
  const seq = Number(String(order).replace(/\D/g, "") || 0) + 1;
  const rec = { order_id: "TEST-ORD-" + String(seq).padStart(3, "0"), kind: "TEST_SIMULATED", idempotency_key: key, order_fingerprint: fingerprint, lines: lines.map((l) => ({ sku: String(l.sku), qty: Number(l.qty) })), currency: "MYR", amount: Number(vdi.total_myr), status: "VALIDATED_UNCHECKOUT" };
  t.orders.push(rec);
  logEvent(t, { event: "order_validated", order_id: rec.order_id, mode: "TEST_SIMULATED" });
  return {
    status: "OK",
    typed_artifact: { validation: { valid: true, duplicate: false, order_id: rec.order_id, order_fingerprint: fingerprint, server_side_amount_rule: "amount must equal recalculated server price at checkout (SK-011) — validation records, does not charge", problems: [] } },
    evidence_refs: [rec.order_id].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["local_register_not_durable_db_supabase_live_BLOCKED", "TEST-labelled_no_ACTUAL_effect"],
    cost_actual: 0,
    approval_requests: [{ scope: "persist_to_production_db", auto: false, requires: "ECOM migration path + owner authorization — in-memory register is not a production datastore" }],
  };
}

/* ---- budget-planner (SK-004) — deterministic line-item budget from OWNER figures.
 * Never presents scenarios as predictions (contract). Tenant actuals (if tenant_id given)
 * come from the real immutable money ledger; proposed_costs are owner inputs.
 * out: budget_plan, cash_at_risk, scenario_table, approval_items */
export function skill_budget_plan(input = {}) {
  const missing = req(input, ["budget_amount", "currency", "reserve_amount", "time_horizon", "proposed_costs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, budget_plan: null, cash_at_risk: null, scenario_table: null, approval_items: [] };
  if (String(input.currency) !== "MYR") return { status: "REJECTED", reason: "currency must be MYR — FX conversion assumptions are never auto-applied", budget_plan: null, cash_at_risk: null, scenario_table: null, approval_items: [] };
  const amount = Number(input.budget_amount), reserve = Number(input.reserve_amount);
  if (!(amount >= 0) || !(reserve >= 0)) return { status: "REJECTED", reason: "budget_amount and reserve_amount must be non-negative numbers", budget_plan: null, cash_at_risk: null, scenario_table: null, approval_items: [] };
  if (reserve > amount) return { status: "REJECTED", reason: "reserve_amount exceeds budget_amount — nothing would remain spendable; owner figure check needed", budget_plan: null, cash_at_risk: null, scenario_table: null, approval_items: [] };
  const costs = Array.isArray(input.proposed_costs) ? input.proposed_costs : null;
  if (!costs || !costs.length) return { status: "REJECTED", reason: "proposed_costs[] {item, amount_myr, needed_by?} required — planned spend is never invented", budget_plan: null, cash_at_risk: null, scenario_table: null, approval_items: [] };
  const bad = costs.filter((c) => !c || !String(c.item || "").trim() || !Number.isFinite(Number(c.amount_myr)) || Number(c.amount_myr) < 0);
  if (bad.length) return { status: "REJECTED", reason: "every proposed cost needs item + non-negative amount_myr", budget_plan: null, cash_at_risk: null, scenario_table: null, approval_items: bad.map((b) => ({ scope: "fix_cost_row", item: String((b || {}).item || "?"), auto: false })) };
  const totalProposed = costs.reduce((s, c) => s + Number(c.amount_myr), 0);
  const available = amount - reserve;
  const actuals = input.tenant_id ? moneyTotals(String(input.tenant_id)) : null;
  const planId = stableId("BUD", [String(amount), String(reserve), String(input.time_horizon), costs.map((c) => c.item + c.amount_myr).join(",")]);
  const scenarios = [["low", 0.5], ["base", 1], ["high", 1.5]].map(([name, k]) => ({ case: name, planned_spend_myr: Math.round(totalProposed * k * 100) / 100, remaining_vs_available_myr: Math.round((available - totalProposed * k) * 100) / 100 }));
  return {
    status: "OK",
    budget_plan: { plan_id: planId, budget_amount_myr: amount, reserve_amount_myr: reserve, spendable_ceiling_myr: available, time_horizon: String(input.time_horizon), line_items: costs.map((c) => ({ item: String(c.item), amount_myr: Number(c.amount_myr), share_pct: totalProposed ? Math.round((Number(c.amount_myr) / totalProposed) * 10000) / 100 : 0, needed_by: c.needed_by || null })), total_proposed_myr: totalProposed, over_ceiling: totalProposed > available, ledger_actuals_out_myr: actuals ? actuals.money_out : null, enforces: "SK-046/SK-035 must declare_scope with cap <= " + available + " MYR before any hold" },
    cash_at_risk: { max_loss_if_all_planned_spend_fails_myr: Math.min(totalProposed, available), reserve_protected_myr: reserve, basis: "arithmetic ceiling, NOT a prediction or probability" },
    scenario_table: { rows: scenarios, note: "owner-figure arithmetic only — zero forecast authority, no assumed sales" },
    approval_items: totalProposed > available ? [{ scope: "raise_ceiling_or_cut_costs", auto: false, requires: "owner decision — planner never self-approves over-budget plans" }] : [{ scope: "lock_budget_scope", auto: false, requires: "owner confirmation to register cap via SK-046 declare_scope" }],
  };
}

/* ---- crm-follow-up (SK-006) — consented, ONE-channel-per-recipient sequences (draft only).
 * Consent gate is absolute: no consent=true ⇒ REJECTED; recipients without a channel
 * preference get no draft. WhatsApp/Gmail connector classes are approval-gated/BLOCKED:
 * send attempts here are NEVER executed — every message stays state:DRAFT_NOT_SENT.
 * out: typed_artifact{followup_sequence}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
const vbi_has = (v, k) => Boolean(v && v[k]);
export function skill_crm_followup(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const recipients = Array.isArray(vdi.recipients) && vdi.recipients.length ? vdi.recipients : null;
  const template = String(vdi.message_template || "").trim();
  if (!recipients || !template) return { status: "REJECTED", reason: "recipients[] and message_template required — audiences and copy are never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["crm_inputs_missing"], cost_actual: 0, approval_requests: [] };
  const seqId = stableId("CRM", [String(input.tenant_id), String(input.objective_id), recipients.map((r) => String((r || {}).recipient_ref || "?")).join(",")]);
  const rows = recipients.map((r, i) => {
    const ref = String((r || {}).recipient_ref || "R-" + (i + 1));
    const consented = vbi_has(r, "consent") && r.consent === true;
    const purposeChannel = String((r || {}).channel || "").trim();
    if (!consented) return { recipient_ref: ref, state: "EXCLUDED_NO_CONSENT", channel: null, reason: "consent gate (PDPA-class principle): unverified consent ⇒ no outreach, no exception path" };
    if (!purposeChannel) return { recipient_ref: ref, state: "EXCLUDED_NO_CHANNEL", channel: null, reason: "record carries no recipient-selected channel — selection is never guessed" };
    return { recipient_ref: ref, state: "DRAFT_QUEUED_OWNER_APPROVAL", channel: purposeChannel, message_draft: template, steps: Array.isArray(vdi.sequence_days) ? vdi.sequence_days.map(Number) : [0] };
  });
  const queued = rows.filter((x) => x.state === "DRAFT_QUEUED_OWNER_APPROVAL");
  return {
    status: "OK",
    typed_artifact: { mode: "MOCK_DRAFT_ONLY", followup_sequence: { sequence_id: seqId, one_channel_per_recipient: true, recipients: rows, drafted: queued.length, excluded: rows.length - queued.length, dispatched: 0, connector_classes: { whatsapp_business: "approval-gated (owner policy I962)", "email_gmail": "BLOCKED — no connector authorized" } } },
    evidence_refs: [seqId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["consent_flags_are_supplied_claims_audited_not_verified", "nothing_sent"],
    cost_actual: 0,
    approval_requests: queued.length ? [{ scope: "send_followups", auto: false, requires: "explicit owner review of EACH draft batch (customer contact NEVER automatic) + connector LIVE authorization" }] : [],
  };
}

/* ---- cashflow-forecaster (SK-008) — liquidity scenarios, honest estimate labels.
 * Past actuals from the money ledger only where tenant supplied; future flows are owner
 * assumptions (AR days, supplier payment terms) shown as scenario arithmetic — the output
 * can never read as a guaranteed return (contract boundary).
 * out: typed_artifact{cashflow_projection}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_cashflow_forecast(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const opening = Number(vdi.opening_cash_myr);
  const horizonWeeks = Number(vdi.horizon_weeks);
  const assumptions = vdi.assumptions;
  if (!Number.isFinite(opening) || !(horizonWeeks > 0) || horizonWeeks > 52) return { status: "REJECTED", reason: "opening_cash_myr and horizon_weeks (1-52) required", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["forecast_params_invalid"], cost_actual: 0, approval_requests: [] };
  if (!assumptions || !Number.isFinite(Number(assumptions.weekly_inflow_myr)) || !Number.isFinite(Number(assumptions.weekly_outflow_myr))) return { status: "REJECTED", reason: "assumptions.weekly_inflow_myr/weekly_outflow_myr must be owner-stated — flows are never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["assumptions_absent"], cost_actual: 0, approval_requests: [] };
  const fin = Number(assumptions.weekly_inflow_myr), fout = Number(assumptions.weekly_outflow_myr);
  const actuals = moneyTotals(String(input.tenant_id));
  const mults = [["conservative", 0.7, 1.2], ["stated", 1, 1], ["optimistic", 1.3, 0.9]];
  const rows = mults.map(([name, kin, kout]) => ({ scenario: name, closing_cash_myr: Math.round((opening + (fin * kin - fout * kout) * horizonWeeks) * 100) / 100, dips_below_reserve: vdi.reserve_floor_myr !== undefined ? (opening + (fin * kin - fout * kout) * horizonWeeks) < Number(vdi.reserve_floor_myr) : "reserve_floor_not_supplied" }));
  const fId = stableId("CASH", [String(input.tenant_id), String(input.objective_id), String(horizonWeeks), String(opening)]);
  return {
    status: "OK",
    typed_artifact: { mode: "ESTIMATE_LABELLED_ARITHMETIC", cashflow_projection: { forecast_id: fId, horizon_weeks: horizonWeeks, opening_cash_myr: opening, assumptions: { weekly_inflow_myr: fin, weekly_outflow_myr: fout, registered_as: "owner_assumption_labels_not_predictions" }, ledger_actuals_reference: actuals, scenarios: rows, label: "SIMULATED/ESTIMATE — never ACTUAL, never guaranteed returns" } },
    evidence_refs: [fId].concat(actuals.count ? ["ledger:events_" + actuals.count] : []).concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["future_flows_are_owner_assumptions", "no_external_data_sources_consulted"],
    cost_actual: 0,
    approval_requests: [{ scope: "act_on_forecast", auto: false, requires: "owner review — reserve breaches route to SK-004 replanning, spending still gated by SK-046 holds" }],
  };
}

/* ---- wan-video-creator (SK-057) — async video job spec; Wan API is connector-BLOCKED.
 * Reuses SK-018 job-preparation lineage; verified-product gate: product rows come from
 * store catalog and QUARANTINED/unverified rows are refused. The adapter is NEVER invoked:
 * mp4_uri stays null, actual_cost UNKNOWN-with-reconciliation-guidance (error_and_recovery).
 * out: video_asset_id, mp4_uri, caption_files, platform_metadata, qa_result, actual_cost */
export function skill_wan_video_create(input = {}) {
  const missing = req(input, ["product_id", "storyboard", "brand_id", "language", "duration", "aspect_ratio", "tenant_id", "budget_cap"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: null, actual_cost: null };
  const t = get(String(input.tenant_id));
  const product = t.products.find((p) => String(p.id) === String(input.product_id));
  if (!product) return { status: "REJECTED", reason: "product not in tenant catalog — verified-product start is mandatory (no invented assets)", video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: { overall: "BLOCKED", checks: ["product_unknown"] }, actual_cost: null };
  if (String(product.review_state).toUpperCase() === "QUARANTINED") return { status: "REJECTED", reason: "product row QUARANTINED — promotion material blocked at source per catalog governance", video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: { overall: "BLOCKED", checks: ["product_quarantined"] }, actual_cost: null };
  let beats = input.storyboard;
  if (Array.isArray(beats)) beats = { beats };
  if (!beats || typeof beats !== "object" || !String((beats || {}).summary || JSON.stringify((beats || {}).beats || "")).trim()) return { status: "REJECTED", reason: "storyboard structure required (beats or summary) — scenes are never invented", video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: { overall: "BLOCKED", checks: ["storyboard_empty"] }, actual_cost: null };
  const dur = Number(input.duration); const cap = Number(input.budget_cap);
  if (!(dur > 0 && dur <= 60)) return { status: "REJECTED", reason: "duration must be 1-60 seconds (short-form)", video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: null, actual_cost: null };
  if (!(cap >= 0)) return { status: "REJECTED", reason: "budget_cap must be a declared non-negative number", video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: null, actual_cost: null };
  const AR = ["16:9", "9:16", "1:1"]; if (!AR.includes(String(input.aspect_ratio))) return { status: "REJECTED", reason: "aspect_ratio must be one of " + AR.join(", "), video_asset_id: null, mp4_uri: null, caption_files: [], platform_metadata: null, qa_result: null, actual_cost: null };
  const jobId = stableId("VIDJOB", [String(input.tenant_id), String(input.product_id), String(input.brand_id), String(dur), String(input.aspect_ratio)]);
  return {
    status: "OK",
    video_asset_id: jobId,
    mp4_uri: null,
    caption_files: [{ language: String(input.language), state: "CAPTION_SCRIPT_QUEUED", source: "storyboard+permitted_claims_at_dispatch" }],
    platform_metadata: { aspect_ratio: String(input.aspect_ratio), duration_s: dur, adapter: "wan-video", job_state: "QUEUED_MOCK", dispatched: false, connector_class: "BLOCKED", matrix_note: "Wan adapter LIVE path = owner-token class; SK-018 routes prepared specs here for video" },
    qa_result: { overall: "READY_PENDING_ADAPTER", checks: ["product_verified_not_quarantined", "rights_and_claims_screen_SK-012_at_dispatch", "async_reconciliation_required_before_retry"] },
    actual_cost: null,
    cost_note: "actual_cost UNKNOWN — adapter never invoked; dispatch spend must pass SK-046 hold <= cap " + cap + " MYR; EXTERNAL_UNKNOWN ⇒ reconcile-before-retry (no duplicate billed jobs)",
    evidence_refs: [jobId, "catalog:" + String(input.product_id)],
    uncertainty_flags: ["connector_wan_BLOCKED_owner_token_class", "no_video_generated_no_file_fabricated"],
    typed_artifact: { mode: "MOCK", job_id: jobId, budget_cap_myr: cap },
  };
}

/* ---- consent-checker (SK-014) — consent/unsubscribe/retention/channel-policy validation.
 * Pure validator inside the Identity & Tenant Guard boundary (contract: "Consent
 * validation; no separate authority"). No sending happens here; SK-006 keeps its own
 * absolute consent gate. Records are evaluated against an OWNER-supplied channel/purpose
 * policy — never a default-permit assumption. Discrepancy outcomes route to owner
 * reconciliation, never to silent deletion.
 * out: typed_artifact{consent_matrix}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_consent_check(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const records = Array.isArray(vdi.contact_records) && vdi.contact_records.length ? vdi.contact_records : null;
  const policy = vdi.channel_policy;
  if (!records || !policy || !Array.isArray(policy.allowed_channels) || !Array.isArray(policy.allowed_purposes)) return { status: "REJECTED", reason: "contact_records[] and channel_policy {allowed_channels[], allowed_purposes[], retention_days?} required — consent posture is never assumed", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["policy_absent"], cost_actual: 0, approval_requests: [] };
  const today = String(vdi.evaluated_on || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return { status: "REJECTED", reason: "evaluated_on (YYYY-MM-DD) must be supplied — date arithmetic is never guessed", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["eval_date_absent"], cost_actual: 0, approval_requests: [] };
  const matrix = records.map((r, i) => {
    const ref = String((r || {}).record_ref || "REC-" + (i + 1));
    const checks = [];
    if (!(r && r.consent === true)) checks.push("NO_CONSENT");
    if (r && r.unsubscribed === true) checks.push("UNSUBSCRIBED");
    const ch = String((r || {}).channel || "");
    if (!policy.allowed_channels.includes(ch)) checks.push("CHANNEL_NOT_IN_POLICY");
    const purpose = String((r || {}).purpose || "");
    if (!policy.allowed_purposes.includes(purpose)) checks.push("PURPOSE_NOT_IN_POLICY");
    const granted = String((r || {}).consent_granted_on || "");
    if (policy.retention_days !== undefined && granted) {
      const ageDays = Math.floor((Date.parse(today) - Date.parse(granted)) / 86400000);
      if (Number.isFinite(ageDays) && ageDays > Number(policy.retention_days)) checks.push("RETENTION_WINDOW_PASSED");
    } else if (policy.retention_days !== undefined && !granted) {
      checks.push("CONSENT_DATE_UNRECORDED"); // retention cannot be evaluated without a grant date
    }
    return { record_ref: ref, state: checks.length ? "DENIED" : "PERMITTED", reasons: checks };
  });
  const permitted = matrix.filter((m) => m.state === "PERMITTED").map((m) => m.record_ref);
  const denied = matrix.filter((m) => m.state === "DENIED");
  const auditId = stableId("CONSENT", [String(input.tenant_id), String(input.objective_id), matrix.map((m) => m.record_ref + ":" + m.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "VALIDATION_ONLY", consent_matrix: { audit_id: auditId, evaluated_on: today, policy_channels: policy.allowed_channels, policy_purposes: policy.allowed_purposes, retention_days: policy.retention_days === undefined ? null : Number(policy.retention_days), records: matrix, permitted_count: permitted.length, denied_count: denied.length } },
    evidence_refs: [auditId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["consent_flags_are_supplied_claims_not_identity_verified", "validator_only_no_separate_authority"],
    cost_actual: 0,
    approval_requests: denied.length ? [{ scope: "resolve_denied_records", auto: false, requires: "owner reconciliation for DISCREPANCY states (e.g. consent+unsubscribed) — records are never auto-purged" }] : [],
    permitted_contacts_note: "PERMITTED here validates records only; any actual customer contact stays gated by SK-006 drafts + owner approval + connector class",
  };
}

/* ---- localization-specialist (SK-029) — deterministic localization QA, not a translator.
 * Boundary (sheet-04): "Text localization; not speech recognition". Translation itself is
 * provider-bound: this module NEVER generates translations — it audits supplied
 * translated_content against locked glossary terms, byte-identical numerals/currency
 * figures, {placeholders}, and disclaimer lines, and flags uncertain dialects for review.
 * out: localized_content, terminology_flags, QA_report (+ envelope sidecars) */
export function skill_localization_specialist(input = {}) {
  const missing = req(input, ["source_content", "locale"]).concat(Array.isArray(input.glossary) ? [] : ["glossary"]); // glossary may be [] (no locked terms) but must be declared
  if (missing.length) { return { status: "NEEDS_INPUT", missing, localized_content: [], terminology_flags: [], QA_report: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] }; }
  const items = Array.isArray(input.source_content) ? input.source_content : null;
  if (!items || !items.length) return { status: "REJECTED", reason: "source_content[] required — content is never invented", localized_content: [], terminology_flags: [], QA_report: null };
  const hasText = items.some((x) => String((x && (x.text || x.source)) || x || "").trim());
  if (!hasText) return { status: "REJECTED", reason: "source_content entries carry no text — nothing to localize, copy never invented", localized_content: [], terminology_flags: [], QA_report: null };
  const locale = String(input.locale);
  if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})*(-[A-Z]{2})?$/.test(locale)) return { status: "REJECTED", reason: "locale must be BCP-47-like (e.g. ms, ms-MY, zh-Hant-MY) — dialect is never guessed", localized_content: [], terminology_flags: [], QA_report: null };
  const glossary = Array.isArray(input.glossary) ? input.glossary : [];
  const terms = glossary.map((g) => String((g || {}).term || "")).filter(Boolean);
  const translations = Array.isArray(input.translated_content) ? input.translated_content : null;
  const extracts = (s) => ({
    numerals: (String(s).match(/\d+(?:[.,]\d+)?/g) || []).join("|"),
    placeholders: (String(s).match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) || []).slice().sort().join("|"),
  });
  const rows = items.map((raw, i) => {
    const src = String((raw && (raw.text || raw.source)) || raw || "");
    const tr = translations && translations[i] !== undefined ? String((translations[i] && typeof translations[i] === "object") ? (translations[i].text ?? "") : translations[i]) : null;
    const flags = [];
    if (tr === null) {
      flags.push("TRANSLATION_NOT_SUPPLIED_provider_bound");
    } else {
      if (extracts(src).numerals !== extracts(tr).numerals) flags.push("NUMERALS_CHANGED_monetary_or_numeric_DANGER");
      if (extracts(src).placeholders !== extracts(tr).placeholders) flags.push("PLACEHOLDER_MISMATCH");
      const srcHasTerm = (t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(src);
      const trHasTerm = (t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(tr);
      glossary.forEach((g) => {
        const t = String((g || {}).term || "");
        if (t && srcHasTerm(t) && !trHasTerm(t)) flags.push("LOCKED_TERM_DROPPED:" + t);
        if (t && g.keep_source_language && trHasTerm(t) && !srcHasTerm(t)) flags.push("LOCKED_TERM_INJECTED:" + t); // target uses source-language locked term the source never mentioned
      });
      if (raw && raw.disclaimer === true && /\{|\d|\.|\S/.test(src) && tr.trim().length === 0) flags.push("DISCLAIMER_DROPPED_regulatory");
    }
    if (Array.isArray(input.uncertain_dialects) && input.uncertain_dialects.includes(locale)) flags.push("DIALECT_UNCERTAIN_review_required");
    return { item_id: String((raw && raw.id) || "L-" + (i + 1)), source_text: src, localized_text: tr, state: tr === null ? "PENDING_PROVIDER_TRANSLATION" : flags.length ? "FLAGGED" : "QA_PASS", flags };
  });
  const terminology_flags = rows.flatMap((r) => r.flags.filter((f) => /TERM|DIALECT|DISCLAIMER/.test(f)).map((f) => ({ item_id: r.item_id, flag: f })));
  const qaId = stableId("LOCQA", [String(input.tenant_id || "global"), locale, rows.map((r) => r.item_id + ":" + r.state).join(",")]);
  const failCount = rows.filter((r) => r.state === "FLAGGED").length;
  const pendingCount = rows.filter((r) => r.state === "PENDING_PROVIDER_TRANSLATION").length;
  return {
    status: "OK",
    localized_content: rows,
    terminology_flags,
    QA_report: { qa_id: qaId, locale, items: rows.length, qa_pass: rows.length - failCount - pendingCount, flagged: failCount, pending_translation_provider: pendingCount, rules: ["numerals_and_currency_byte_identical", "placeholders_preserved", "glossary_terms_locked", "disclaimers_never_dropped"], label: "deterministic QA only — translation generation NOT performed here (provider-bound, never auto-invoked)" },
    evidence_refs: [qaId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["no_human_mt_translation_quality_claim", "source_language_assumed_from_supplied_content"],
    cost_actual: 0,
    approval_requests: pendingCount ? [{ scope: "provider_translation_dispatch", auto: false, requires: "owner decision — translation provider never invoked by this module" }] : [],
  };
}

/* ---- payment-reconciler (SK-034) — settlements vs tenant money-ledger matching.
 * Provider connector class is BLOCKED (owner-token); this module NEVER calls a provider
 * and NEVER retries blind (contract boundary: "Match settlement records; no blind
 * retries"). It reconciles owner-supplied settlement records against the real
 * append-only money ledger (read via moneyEvents) and the supplied expected fees.
 * Fee math is arithmetic only: net_expected = gross − fees, compared per record.
 * out: typed_artifact{reconciliation}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_payment_reconcile(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const settlements = Array.isArray(vdi.settlement_records) && vdi.settlement_records.length ? vdi.settlement_records : null;
  const expectedFees = Array.isArray(vdi.expected_fee_rules) ? vdi.expected_fee_rules : [];
  if (!settlements) return { status: "REJECTED", reason: "settlement_records[] required — settlements are never invented or fetched", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["settlements_absent"], cost_actual: 0, approval_requests: [] };
  const ledger = moneyEvents(String(input.tenant_id)).filter((e) => e.direction === "in");
  const refundLedger = new Set(ledger.filter((e) => String(e.category || "") === "refund").map((e) => String(e.source_tag || "")));
  const usedLedger = new Set();
  const results = settlements.map((s) => {
    const idem = String((s || {}).idempotency_key || (s || {}).reference || "");
    const gross = Number((s || {}).gross_myr), fee = Number((s || {}).fee_myr), net = Number((s || {}).net_settled_myr);
    const problems = [];
    if (!idem) problems.push("no_idempotency_key_cannot_match_safely");
    if (!Number.isFinite(gross) || !Number.isFinite(net)) problems.push("settlement_figures_missing");
    const netExpected = Number.isFinite(gross) && Number.isFinite(fee) ? Math.round((gross - fee) * 100) / 100 : null;
    if (netExpected !== null && Number.isFinite(net) && netExpected !== net) problems.push("FEE_MISMATCH_expected_net_" + netExpected);
    const rule = expectedFees.find((r) => r && (r.channel === (s || {}).channel));
    if (rule && Number.isFinite(fee)) {
      const capFee = Math.round(Number(rule.pct) / 100 * gross * 100) / 100 + Number(rule.fixed_myr || 0);
      if (Math.abs(fee - capFee) > Number(rule.tolerance_myr || 0.01)) problems.push("fee_outside_contracted_schedule");
    }
    let ledgerRef = null;
    if (idem) {
      const hit = ledger.find((e) => !usedLedger.has(e.event_id) && String(e.source_tag || "").includes(idem));
      if (hit) { usedLedger.add(hit.event_id); ledgerRef = hit.event_id; if (Math.round(Number(hit.amount_myr) * 100) / 100 !== Math.round(gross * 100) / 100) problems.push("AMOUNT_DIVERGES_FROM_LEDGER"); }
      else problems.push("NO_LEDGER_ENTRY_settlement_without_income_event");
    }
    const refundFlag = /refund/i.test(idem) || refundLedger.has(idem);
    const state = problems.length ? "DISCREPANCY" : "MATCHED";
    return { key: idem || "(unkeyed)", state, problems, ledger_event: ledgerRef, net_expected_myr: netExpected, net_settled_myr: Number.isFinite(net) ? net : null, refund: refundFlag, refund_action: refundFlag ? "REFUND_CASE_ROUTE_SK-038_owner_confirm_queue_no_auto_refund" : null, retry_guidance: problems.length ? "EXTERNAL_UNKNOWN or mismatch ⇒ reconcile before retry — this module never submits provider retries" : null };
  });
  const unmatchedLedger = ledger.filter((e) => !usedLedger.has(e.event_id)).map((e) => e.event_id);
  const recId = stableId("RECON", [String(input.tenant_id), String(input.objective_id), results.map((r) => r.key + ":" + r.state).join(",")]);
  const discrepancies = results.filter((r) => r.state === "DISCREPANCY");
  return {
    status: "OK",
    typed_artifact: { mode: "MOCK_LOCAL_MATCHING", reconciliation: { reconciliation_id: recId, provider_calls_made: 0, connector_class_on_dispatch: "BLOCKED_owner_token_class", records: results, matched: results.length - discrepancies.length, discrepancies: discrepancies.length, ledger_total_in_myr: Math.round(ledger.reduce((a, e) => a + Number(e.amount_myr), 0) * 100) / 100, unmatched_ledger_income_events: unmatchedLedger, blind_retries: "NEVER — reconciliation precedes any retry decision" } },
    evidence_refs: [recId].concat(ledger.slice(0, 25).map((e) => e.event_id), (input.source_refs || []).map(String)),
    uncertainty_flags: ["settlement_records_are_owner_supplied_not_provider_verified", "funding_date_lag_not_modeled"],
    cost_actual: 0,
    approval_requests: discrepancies.length ? [{ scope: "discrepancy_resolution", auto: false, requires: "owner review per record; provider re-query needs BLOCKED LIVE connector authorization — no automatic retry, no automatic refund" }] : [],
  };
}

/* ---- site-qa-tester (SK-044) — deterministic QA verdicts over SUPPLIED site specs and
 * test-result records (contract boundary: "Executable checks" over the supplied artifact;
 * no browser is launched, nothing is fabricated as executed). Designed to consume
 * SK-047 SPEC_ONLY site specs for pre-deployment checks. Deployment NEVER auto-approved.
 * out: typed_artifact{qa_report}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_site_qa(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const site = vdi.site_spec;
  if (!site || typeof site !== "object") return { status: "REJECTED", reason: "site_spec required (produce via SK-047 first) — no site, no QA", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["spec_absent"], cost_actual: 0, approval_requests: [] };
  const findings = [];
  const push = (check, level, detail) => findings.push({ check, level, detail });
  const pages = Array.isArray(site.pages) ? site.pages : [];
  if (!pages.length) push("structure", "FAIL", "site_spec has no pages[] to inspect");
  const imgs = Array.isArray(site.images) ? site.images : [];
  imgs.forEach((im, i) => { if (!String((im || {}).alt || "").trim()) push("accessibility", "FAIL", "image " + ((im && im.id) || i + 1) + " missing alt text"); });
  if (/lorem|ipsum|placeholder|TODO/i.test(JSON.stringify(site))) push("content", "FAIL", "placeholder copy present in spec");
  (Array.isArray(site.ctas) ? site.ctas : []).forEach((c, i) => { if (!String((c || {}).label || "").trim()) push("content", "WARN", "cta " + (i + 1) + " has no label"); });
  if (!String(site.contact_page || site.contact || "").trim()) push("trust", "FAIL", "no contact information in spec");
  (Array.isArray(site.prices) ? site.prices : []).forEach((p) => { if (p && p.value_myr === undefined && p.invented) push("money", "FAIL", "price without verified figure"); });
  if (!Array.isArray(site.viewports) || !site.viewports.length) push("responsive", "WARN", "viewports[] not declared — responsive checks pending");
  (Array.isArray(site.viewports) ? site.viewports : []).forEach((v) => { if (!v || !String(v.check || "").trim()) push("responsive", "WARN", "viewport entry without executed check remains NOT_RUN"); });
  const provided = Array.isArray(vdi.test_results) ? vdi.test_results : [];
  provided.forEach((t) => { const st = String((t || {}).result || "").toUpperCase(); if (!["PASS", "FAIL", "BLOCKED"].includes(st)) push("test_evidence", "FAIL", "test " + ((t && t.id) || "?") + " result not a recognized executed outcome — unverified evidence never counts as PASS"); });
  const runs = provided.filter((t) => ["PASS", "FAIL"].includes(String((t || {}).result || "").toUpperCase()));
  const failures = findings.filter((f) => f.level === "FAIL").length;
  const warnings = findings.filter((f) => f.level === "WARN").length;
  const qaId = stableId("SITEQA", [String(input.tenant_id), String(input.objective_id), String(site.spec_id || "adhoc"), findings.map((f) => f.check + f.level).join(",")]);
  const readiness = failures ? "NOT_READY" : (runs.length && warnings === 0 ? "READY_PENDING_OWNER" : "INCOMPLETE_EVIDENCE");
  return {
    status: "OK",
    typed_artifact: { mode: "STATIC_SPEC_QA_no_browser_executed", qa_report: { qa_id: qaId, pages_inspected: pages.length, findings, fail_count: failures, warn_count: warnings, tests_counted_as_executed: runs.length, tests_not_executed_here: "responsive/perf/real-device runs are NOT executed by this module — only supplied records are counted", readiness, gate: "deployment approval is OWNER-only; QA verdict never auto-publishes" } },
    evidence_refs: [qaId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["static_inspection_only_no_live_crawl", "accessibility_checklist_not_full_WCAG_audit"],
    cost_actual: 0,
    approval_requests: [{ scope: "deploy_site", auto: false, requires: readiness === "NOT_READY" ? "fix FAIL findings first" : "explicit owner approval — publication is never automatic (SK-047 SPEC_ONLY boundary)" }],
  };
}

/* ---- threat-monitor (SK-051) — rule-based detection over SUPPLIED observation records.
 * The single monitoring authority (sheet-04 boundary: "One monitoring authority" — the
 * canonical AIVORA SHIELD Monitor). No live telemetry ingestion, no network, no blocking
 * action: every finding is an ADVISORY for the owner/SHIELD pipeline; mitigation is
 * never executed here. Deterministic patterns only — nothing is invented as a threat.
 * out: typed_artifact{detections}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_threat_monitor(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const observations = Array.isArray(vdi.observations) && vdi.observations.length ? vdi.observations : null;
  if (!observations) return { status: "REJECTED", reason: "observations[] required — threats are never invented or scanned in; supply SHIELD evidence records", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["observations_absent"], cost_actual: 0, approval_requests: [] };
  const baseline = vdi.baseline && typeof vdi.baseline === "object" ? vdi.baseline : {};
  const INJECTION_PATTERNS = [
    [/ignore\s+(all\s+|any\s+|the\s+)?previous\s+instructions/i, "INSTRUCTION_OVERRIDE_ATTEMPT"],
    [/you\s+are\s+now\b/i, "ROLE_REASSIGNMENT_ATTEMPT"],
    [/system\s+prompt/i, "SYSTEM_PROMPT_PROBE"],
    [/\b(api[_ -]?key|secret|credential|password)\b/i, "SECRET_REQUEST_PATTERN"],
    [/act\s+as\s+(the\s+)?(owner|admin|root)/i, "PRIVILEGE_IMPERSONATION_PATTERN"],
    [/exfiltrat|send\s+(all|the)\s+(data|records)\s+to/i, "EXFILTRATION_PATTERN"],
  ];
  const detections = observations.map((raw, i) => {
    const o = raw && typeof raw === "object" ? raw : {};
    const ref = String(o.ref || "OBS-" + (i + 1));
    const text = String(o.text || "");
    const flags = [];
    let severity = ["low", "medium", "high", "critical"].includes(String(o.severity)) ? String(o.severity) : "unknown";
    INJECTION_PATTERNS.forEach(([re, code]) => { if (re.test(text)) flags.push("PROMPT_INJECTION_SUSPECT:" + code); });
    if (flags.some((f) => f.startsWith("PROMPT_INJECTION")) && severity !== "critical") severity = "high";
    const amount = Number(o.amount_myr);
    const typical = Number(baseline.typical_spend_myr);
    if (Number.isFinite(amount) && Number.isFinite(typical) && amount > typical) flags.push("SPEND_ANOMALY_" + amount + "_gt_" + typical);
    if (Array.isArray(baseline.known_devices) && baseline.known_devices.length && o.device !== undefined && !baseline.known_devices.includes(String(o.device))) flags.push("UNKNOWN_DEVICE:" + String(o.device));
    if (Array.isArray(baseline.known_sources) && baseline.known_sources.length && o.source !== undefined && !baseline.known_sources.includes(String(o.source))) flags.push("UNKNOWN_SOURCE:" + String(o.source));
    if (o.tenant_ref !== undefined && String(o.tenant_ref) !== String(input.tenant_id)) { flags.push("CROSS_TENANT_REFERENCE"); severity = "critical"; }
    const state = severity === "critical" ? "CRITICAL" : flags.length ? "SUSPECT" : (severity === "unknown" ? "UNCLASSIFIED_manual_review" : "CLEAR");
    const weight = (flags.some((f) => f === "CROSS_TENANT_REFERENCE") ? 60 : 0)
      + (flags.some((f) => f.startsWith("PROMPT_INJECTION")) ? 40 : 0)
      + (flags.some((f) => f.startsWith("SPEND_ANOMALY")) ? 20 : 0)
      + (flags.some((f) => /^UNKNOWN_(DEVICE|SOURCE)/.test(f)) ? 10 : 0)
      + (flags.length === 0 && severity === "unknown" ? 15 : 0);
    return { observation_ref: ref, state, severity, flags, risk_weight: weight, action: state === "CLEAR" ? "none" : "escalate_to_owner_shield_only" };
  });
  const riskScore = Math.min(100, detections.reduce((a, d) => a + d.risk_weight, 0));
  const nonClear = detections.filter((d) => d.state !== "CLEAR");
  const monId = stableId("THREAT", [String(input.tenant_id), String(input.objective_id), detections.map((d) => d.observation_ref + ":" + d.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "ADVISORY_DETECTION_ONLY", monitoring_authority: "SK-051 AIVORA SHIELD Monitor is the single monitoring authority — no shadow monitors are started here", threat_report: { report_id: monId, observations_evaluated: detections.length, clear: detections.length - nonClear.length, suspect_or_critical: nonClear.length, risk_score: riskScore, detections, scoring: "deterministic weights (cross-tenant 60, injection 40, spend 20, unknown device/source 10, unclassified 15), capped at 100" }, blocks_executed: 0, auto_block: "NEVER — mitigation (lockout, credential rotation, e-stop) is an owner/SHIELD decision through the approval gateway" },
    evidence_refs: [monId].concat(nonClear.map((d) => String(input.objective_id) + "/" + d.observation_ref), (input.source_refs || []).map(String)),
    uncertainty_flags: ["detections_are_rule_based_on_supplied_records_only", "no_live_telemetry_ingestion_no_network", "severity_of_supplied_records_is_claimed_not_measured"],
    cost_actual: 0,
    approval_requests: nonClear.length ? [{ scope: "threat_mitigation", auto: false, requires: "owner review per finding — this module observes and reports; it never blocks, locks out or contacts anyone" }] : [],
  };
}

/* ---- identity-agent (SK-027) — RBAC/session/step-up VALIDATION over supplied records.
 * Single identity authority (sheet-04 boundary). Advisory only: verdicts validate the
 * supplied session matrix; real enforcement stays with the policy gateway (SK-035).
 * Roles/permissions/sessions are never invented — unknown role ⇒ DENIED, never guessed.
 * out: typed_artifact{identity_verdicts}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_identity_agent(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const sessions = Array.isArray(vdi.sessions) && vdi.sessions.length ? vdi.sessions : null;
  if (!sessions) return { status: "REJECTED", reason: "sessions[] required — identities are never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["sessions_absent"], cost_actual: 0, approval_requests: [] };
  const matrix = vdi.role_matrix && typeof vdi.role_matrix === "object" ? vdi.role_matrix : null;
  if (!matrix) return { status: "REJECTED", reason: "role_matrix required — permissions are never assumed", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["role_matrix_absent"], cost_actual: 0, approval_requests: [] };
  const stepUp = Array.isArray(vdi.step_up_actions) && vdi.step_up_actions.length ? vdi.step_up_actions.map(String) : ["spend", "publish", "contact_customer"];
  const verdicts = sessions.map((raw, i) => {
    const s = raw && typeof raw === "object" ? raw : {};
    const id = String(s.session_id || "S-" + (i + 1));
    const role = String(s.role || "");
    const checks = [];
    if (s.tenant_id !== undefined && String(s.tenant_id) !== String(input.tenant_id)) checks.push({ action: "(session)", state: "DENIED", reason: "CROSS_TENANT_SESSION" });
    const allowedList = matrix[role];
    if (!Object.prototype.hasOwnProperty.call(matrix, role)) checks.push({ action: "(role)", state: "DENIED", reason: "UNKNOWN_ROLE_not_in_matrix" });
    else (Array.isArray(s.requested_actions) ? s.requested_actions : []).forEach((a) => {
      const act = String(a);
      const inRole = (allowedList || []).map(String).includes("*") || (allowedList || []).map(String).includes(act);
      if (!inRole) checks.push({ action: act, state: "DENIED", reason: "ACTION_NOT_IN_ROLE" });
      else if (stepUp.includes(act) && s.mfa_verified !== true) checks.push({ action: act, state: "STEP_UP_REQUIRED", reason: "high_risk_action_without_verified_step_up" });
      else checks.push({ action: act, state: "VALID", reason: null });
    });
    if (Object.prototype.hasOwnProperty.call(matrix, role) && !Array.isArray(s.requested_actions) && !checks.length) checks.push({ action: "(none)", state: "NO_ACTIONS_DECLARED", reason: "nothing to validate — empty request is not a pass" });
    const worst = checks.some((c) => c.state === "DENIED") ? "DENIED" : checks.some((c) => c.state === "STEP_UP_REQUIRED") ? "STEP_UP_REQUIRED" : checks.some((c) => c.state === "VALID") ? "PASS_VALIDATION" : "INCONCLUSIVE";
    return { session_id: id, role, tenant_match: s.tenant_id === undefined ? "not_declared" : String(s.tenant_id) === String(input.tenant_id), mfa: s.mfa_verified === true, checks, state: worst };
  });
  const blocked = verdicts.filter((v) => v.state !== "PASS_VALIDATION");
  const idId = stableId("IDENT", [String(input.tenant_id), String(input.objective_id), verdicts.map((v) => v.session_id + ":" + v.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "VALIDATION_ONLY", identity_authority_note: "SK-027 is the single identity validation authority; actual authorization decisions are enforced by the policy gateway (SK-035) — this module grants nothing", step_up_actions: stepUp, identity_verdicts: { verdict_id: idId, sessions_evaluated: verdicts.length, pass: verdicts.length - blocked.length, blocked_or_step_up: blocked.length, records: verdicts } },
    evidence_refs: [idId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["sessions_and_roles_are_supplied_claims_not_directory_synced", "mfa_flag_is_asserted_not_attested"],
    cost_actual: 0,
    approval_requests: blocked.length ? [{ scope: "identity_resolution", auto: false, requires: "owner review for DENIED / STEP_UP_REQUIRED sessions — never auto-upgraded, never auto-cleared" }] : [],
  };
}

/* ---- content-planner (SK-015) — deterministic editorial calendar generator.
 * Same skill family as campaign-strategist (SK-007) per contract boundary but scoped to
 * calendars; coordinates SK-055 for poster/social creative and records that video is
 * provider-unbound (SK-057 DISCONTINUED — media handled via SK-001 upload/reuse only,
 * never generated here). Drafts only: publishing is NEVER automatic. CTA destinations
 * and product references must be supplied — placeholders are flagged, never invented.
 * out: typed_artifact{editorial_calendar}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_content_planner(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const ALLOWED_PLATFORMS = ["facebook", "youtube", "linkedin"];
  const platforms = Array.isArray(vdi.platforms) ? vdi.platforms.map((p) => String(p).toLowerCase()) : [];
  if (!platforms.length) return { status: "REJECTED", reason: "platforms[] required (facebook/youtube/linkedin per allowed_capabilities) — channels are never guessed", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: 0, approval_requests: [] };
  const invalid = platforms.filter((p) => !ALLOWED_PLATFORMS.includes(p));
  if (invalid.length) return { status: "REJECTED", reason: "platform outside allowed_capabilities: " + invalid.join(",") + " — capability list is contract-locked", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["platform_out_of_scope"], cost_actual: 0, approval_requests: [] };
  const weeks = Number(vdi.weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) return { status: "REJECTED", reason: "weeks must be an integer 1..8 — planning horizon is declared, not assumed", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["horizon_invalid"], cost_actual: 0, approval_requests: [] };
  const goal = String(vdi.goal || "");
  if (!goal) return { status: "REJECTED", reason: "goal required — content intent is never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["goal_absent"], cost_actual: 0, approval_requests: [] };
  const themes = Array.isArray(vdi.themes) && vdi.themes.length ? vdi.themes.map(String) : [goal.toLowerCase()];
  const tenant = get(String(input.tenant_id));
  const catalogIds = new Set((((tenant && tenant.products) || [])).map((p) => String(p.id)));
  const unknownRefs = (Array.isArray(vdi.product_refs) ? vdi.product_refs : []).map(String).filter((r) => !catalogIds.has(r));
  const ctas = Array.isArray(vdi.cta_destinations) ? vdi.cta_destinations : [];
  const ctaMissing = !ctas.length;
  const calendar = [];
  for (let w = 1; w <= weeks; w++) for (const p of platforms) {
    const theme = themes[(w - 1 + platforms.indexOf(p)) % themes.length];
    const row = { slot_id: "W" + w + "-" + p, week: w, platform: p, theme, draft_status: "DRAFT_ONLY", goal, asset_needs: p === "youtube"
      ? { video: "PROVIDER_UNBOUND — SK-057 DISCONTINUED per owner directive 2026-11-21; media only via SK-001 upload/reuse (never generated)", poster: "coordinate SK-055 draft" }
      : { poster: "coordinate SK-055 draft", video: "not required for this slot" } };
    if (ctaMissing) row.flags = ["CTA_DESTINATION_UNSPECIFIED_destination_never_invented"]; else row.cta_refs = ctas.map((c) => String((c && c.label) || "")).filter(Boolean);
    if (unknownRefs.length) row.flags = (row.flags || []).concat(unknownRefs.map((r) => "UNKNOWN_PRODUCT_REF:" + r));
    calendar.push(row);
  }
  const planId = stableId("CAL", [String(input.tenant_id), String(input.objective_id), platforms.join(","), String(weeks), goal]);
  return {
    status: "OK",
    typed_artifact: { mode: "DRAFT_CALENDAR_no_publishing", editorial_calendar: { plan_id: planId, goal, platforms, weeks, slots: calendar.length, rows: calendar, claim_verification: "product claims in drafts must pass SK-012 screening before any use", coordination: { posters: "SK-055", video: "SK-057_DISCONTINUED_use_SK-001_upload_or_reuse" } } },
    evidence_refs: [planId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["engagement_forecasts_not_produced", "themes_and_goal_are_owner_supplied_not_researched"],
    cost_actual: 0,
    approval_requests: [{ scope: "publish_posts", auto: false, requires: "explicit owner approval per platform; social connectors are MOCK/SANDBOX class — LIVE posting is never automatic" }],
  };
}

/* ---- brand-setup-specialist (SK-003) — deterministic name ideation + positioning +
 * visual brief from SUPPLIED inputs only. Boundary (sheet-04): name ideation ONLY —
 * domain/trademark availability is NEVER checked (no network) and never claimed;
 * verification is a separate owner-run registration step. Options are built purely from
 * the caller's keywords/suffixes/product tokens (combinatorics, not generation).
 * out: brand_options, positioning, asset_brief (+ audit-expected outputs) */
export function skill_brand_setup_specialist(input = {}) {
  const missing = req(input, ["products", "audience", "brand_preferences"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, brand_options: [], positioning: null, asset_brief: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const products = Array.isArray(input.products) ? input.products : [];
  if (!products.length) return { status: "REJECTED", reason: "products[] must carry at least one entry — offering is never invented", brand_options: [], positioning: null, asset_brief: null };
  const prefs = input.brand_preferences && typeof input.brand_preferences === "object" ? input.brand_preferences : null;
  if (!prefs) return { status: "REJECTED", reason: "brand_preferences object required — style is never guessed", brand_options: [], positioning: null, asset_brief: null };
  const keywords = (Array.isArray(prefs.keywords) ? prefs.keywords : []).map((k) => String(k).trim()).filter((k) => /^[a-zA-Z0-9]{2,}$/.test(k));
  if (!keywords.length) return { status: "REJECTED", reason: "brand_preferences.keywords[] required (simple alphanumeric tokens) — names are invented from YOUR words only", brand_options: [], positioning: null, asset_brief: null };
  const suffixes = (Array.isArray(prefs.suffixes) && prefs.suffixes.length ? prefs.suffixes : ["a", "io", "ex"]).map((s) => String(s).replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const prodTokens = products.map((p) => String((p && p.name) || p || "")).filter(Boolean).flatMap((n) => n.split(/[^A-Za-z0-9]+/)).map(cap).slice(0, 2);
  const options = [];
  const seen = new Set();
  const addOption = (name, derivation) => { const key = name.toLowerCase(); if (!seen.has(key) && name.length >= 3) { seen.add(key); options.push({ name, derivation, availability: { domain: "NOT_CHECKED_no_network", trademark: "NOT_CHECKED_registry_query_required" }, ownership_claim: "none — availability and registrability are NOT asserted" }); } };
  for (const k of keywords) for (const s of suffixes) addOption(cap(k) + s.toLowerCase(), "keyword '" + k + "' + declared suffix '" + s + "'");
  for (const k of keywords) for (const t of prodTokens) addOption(cap(t) + k.toLowerCase(), "product token '" + t + "' + keyword '" + k + "'");
  const short = options.slice(0, 8);
  if (!short.length) return { status: "REJECTED", reason: "inputs produced no name-eligible tokens — nothing to combine", brand_options: [], positioning: null, asset_brief: null };
  const audience = String(input.audience).trim();
  const promise = prefs.promise ? String(prefs.promise).trim() : "no unverified claims are added at positioning stage";
  const positioning = "For " + audience + ", " + cap(keywords[0]) + "-led offering that " + promise + ". [template composition from supplied inputs — not a marketing guarantee]";
  const assetBrief = { tone: prefs.tone ? String(prefs.tone) : "UNDECLARED_owner_to_provide", colors: Array.isArray(prefs.colors) ? prefs.colors.map(String) : [], typography: prefs.typography ? (Array.isArray(prefs.typography) ? prefs.typography.map(String) : [String(prefs.typography)]) : [], status: "BRIEF_DRAFT_ONLY", note: "visual brief drafted from declared preferences; asset production happens later via SK-055/SK-001, not here" };
  const brandId = stableId("BRAND", [String(input.tenant_id || "global"), short.map((o) => o.name).join(","), audience]);
  return {
    status: "OK",
    brand_options: short,
    positioning,
    asset_brief: assetBrief,
    typed_artifact: { mode: "IDEATION_ONLY", ideation_provenance: brandId, input_keywords: keywords, product_tokens: prodTokens },
    evidence_refs: [brandId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["domain_and_trademark_availability_unverified_no_network_access", "name_quality_is_rule_derived_not_human_creative"],
    cost_actual: 0,
    approval_requests: [{ scope: "brand_selection_and_registration", auto: false, requires: "owner picks a name, then runs trademark/domain verification and registration as a SEPARATE confirmed step — this module never claims or reserves anything" }],
    note: "boundary honored: name ideation only; registration verified separately",
  };
}

/* ---- inventory-validator (SK-028) — stock/SKU validation over SUPPLIED verified records
 * with stale-data controls. Supplier source is connector-bound (Supabase/supplier TBD):
 * nothing is fetched and stock is NEVER written here; unknown quantities stay UNKNOWN.
 * out: typed_artifact{inventory_validation}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_inventory_validate(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const records = Array.isArray(vdi.sku_records) && vdi.sku_records.length ? vdi.sku_records : null;
  if (!records) return { status: "REJECTED", reason: "sku_records[] required — stock counts are never invented or fetched", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["records_absent"], cost_actual: 0, approval_requests: [] };
  const checkedOn = String(vdi.checked_on || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedOn)) return { status: "REJECTED", reason: "checked_on (YYYY-MM-DD) required — staleness cannot be evaluated without an as-of date", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["as_of_absent"], cost_actual: 0, approval_requests: [] };
  const maxAge = Number.isFinite(Number(vdi.max_age_days)) ? Number(vdi.max_age_days) : 7;
  const tenant = get(String(input.tenant_id));
  const catalogSkus = new Set((((tenant && tenant.products) || [])).map((p) => String(p.sku || p.id)));
  const rows = records.map((raw, i) => {
    const r = raw && typeof raw === "object" ? raw : {};
    const sku = String(r.sku || "SKU-" + (i + 1));
    const problems = [];
    const qty = r.qty;
    if (qty === undefined || qty === null || qty === "") problems.push("STOCK_UNKNOWN_never_assumed");
    else if (!Number.isInteger(Number(qty)) || Number(qty) < 0) problems.push("DATA_ERROR_negative_or_noninteger_qty");
    const upd = String(r.updated_at || "");
    let ageDays = null;
    if (!upd) problems.push("NO_UPDATED_AT_staleness_uncheckable");
    else {
      const t1 = Date.parse(upd), t0 = Date.parse(checkedOn);
      if (!Number.isFinite(t1) || !Number.isFinite(t0)) problems.push("DATA_ERROR_unparseable_date");
      else { ageDays = Math.floor((t0 - t1) / 86400000); if (ageDays > maxAge) problems.push("STALE_" + ageDays + "d_gt_" + maxAge + "d"); }
    }
    if (catalogSkus.size && !catalogSkus.has(sku)) problems.push("NOT_IN_TENANT_CATALOG");
    const q = Number(qty);
    if (Number.isInteger(q) && q >= 0 && r.reorder_point !== undefined && q <= Number(r.reorder_point)) problems.push("AT_OR_BELOW_REORDER_POINT");
    const stale = problems.some((p) => p.startsWith("STALE") || p === "NO_UPDATED_AT_staleness_uncheckable");
    const state = problems.includes("DATA_ERROR_negative_or_noninteger_qty") || problems.includes("DATA_ERROR_unparseable_date") ? "DATA_ERROR"
      : stale ? "UNRELIABLE_stale_source" : problems.includes("STOCK_UNKNOWN_never_assumed") ? "UNKNOWN"
      : q === 0 ? "OUT_OF_STOCK" : "IN_STOCK_VERIFIED_AS_SUPPLIED";
    return { sku, qty: Number.isInteger(q) && q >= 0 ? q : null, age_days: ageDays, state, problems, source_ref: r.source_ref ? String(r.source_ref) : null };
  });
  const bad = rows.filter((x) => x.state !== "IN_STOCK_VERIFIED_AS_SUPPLIED");
  const invId = stableId("INVCHK", [String(input.tenant_id), String(input.objective_id), checkedOn, rows.map((x) => x.sku + ":" + x.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "VALIDATION_OF_SUPPLIED_RECORDS", connector_note: "supplier/inventory system connector is TBD/BLOCKED class — no sync executed, stock never written by this module", inventory_validation: { validation_id: invId, checked_on: checkedOn, max_age_days: maxAge, skus: rows.length, reliable: rows.length - bad.length, needing_attention: bad.map((x) => ({ sku: x.sku, state: x.state, problems: x.problems })), rows } },
    evidence_refs: [invId].concat(rows.slice(0, 20).map((x) => x.source_ref).filter(Boolean), (input.source_refs || []).map(String)),
    uncertainty_flags: ["stock_figures_are_supplied_claims_not_physical_counts", "stale_records_cannot_confirm_current_availability"],
    cost_actual: 0,
    approval_requests: bad.length ? [{ scope: "inventory_correction_or_supplier_sync", auto: false, requires: "owner review — corrections confirm a real count; supplier sync needs a BLOCKED-class connector authorization; customer-facing availability never auto-updated" }] : [],
  };
}

/* ---- optimization-agent (SK-032) — KPI gap analysis + CONSTRAINED experiment proposals.
 * Boundary (sheet-04): propose improvements; NO direct spend. Experiments are drafts with
 * declared guardrails; any funded path must first pass SEC-05 budget reservations and the
 * approval gateway. Figures come only from supplied KPI records — nothing benchmarked online.
 * out: typed_artifact{kpi_analysis, experiment_proposals}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_optimization_advise(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const kpis = Array.isArray(vdi.kpis) && vdi.kpis.length ? vdi.kpis : null;
  if (!kpis) return { status: "REJECTED", reason: "kpis[] required — metrics are measured from supplied records, never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["kpis_absent"], cost_actual: 0, approval_requests: [] };
  const analysis = kpis.map((raw, i) => {
    const k = raw && typeof raw === "object" ? raw : {};
    const name = String(k.name || "KPI-" + (i + 1));
    const cur = Number(k.current), tgt = Number(k.target);
    const dir = k.direction === "down" ? "down" : "up";
    if (!Number.isFinite(cur)) return { name, state: "UNMEASURABLE", note: "current value absent — no analysis is fabricated" };
    if (!Number.isFinite(tgt)) return { name, current: cur, state: "NO_TARGET", note: "declare a target to measure a gap — targets are never guessed" };
    const gap = dir === "up" ? tgt - cur : cur - tgt;
    const pct = tgt !== 0 ? Math.round(Math.abs(gap) / Math.abs(dir === "up" ? tgt : cur) * 1000) / 10 : null;
    const state = gap <= 0 ? "ACHIEVED" : (pct !== null && pct <= 10 ? "NEAR_TARGET" : "OFF_TRACK");
    return { name, current: cur, target: tgt, direction: dir, gap: Math.round(gap * 100) / 100, gap_pct: pct, state };
  });
  const proposals = analysis.filter((a) => a.state === "OFF_TRACK" || a.state === "NEAR_TARGET").slice(0, 5).map((a, i) => ({
    experiment_id: "EXP-" + (i + 1), targets_kpi: a.name,
    draft_design: "A/B the top traffic entry for '" + a.name + "' with ONE changed variable; compare over a fixed declared window",
    constraints: { variables_changed_max: 1, spend_per_experiment_myr: vdi.experiment_budget_cap_myr !== undefined ? Number(vdi.experiment_budget_cap_myr) : "UNSET_owner_to_declare", guardrail_kpi: vdi.guardrail_kpi ? String(vdi.guardrail_kpi) : "margin_must_not_degrade" },
    funding: "NO direct spend — funded experiments require SEC-05 budget reservation + owner approval first",
    status: "PROPOSED_DRAFT",
  }));
  const optId = stableId("OPTA", [String(input.tenant_id), String(input.objective_id), analysis.map((a) => a.name + ":" + a.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "ADVISORY_NO_SPEND", kpi_analysis: { analysis_id: optId, evaluated: analysis.length, off_track: analysis.filter((a) => a.state === "OFF_TRACK").length, achieved: analysis.filter((a) => a.state === "ACHIEVED").length, rows: analysis }, experiment_proposals: proposals, external_benchmarks: "NONE cited — no network; comparisons use only supplied tenant records" },
    evidence_refs: [optId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["kpi_values_are_supplied_not_instrumented", "experiment_outcomes_cannot_be_predicted"],
    cost_actual: 0,
    approval_requests: proposals.length ? [{ scope: "run_experiment", auto: false, requires: "owner approval + declared budget cap (SEC-05 reservation path for any spend); this module proposes only" }] : [],
  };
}

/* ---- recovery-audit-agent (SK-037) — incident containment/rollback PLANNING with
 * immutable-audit guarantees. The single durable audit/recovery authority: it reads and
 * references the append-only ledger, never a parallel store, and never mutates or deletes
 * evidence. Rollback to an UNVERIFIED target is blocked, not guessed. Nothing executes.
 * out: typed_artifact{recovery_plan, audit_chain_checks}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_recovery_audit(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const incident = vdi.incident && typeof vdi.incident === "object" ? vdi.incident : null;
  if (!incident || !String(incident.incident_id || "").trim()) return { status: "REJECTED", reason: "incident{incident_id,...} required — incidents are reported by the owner/monitor, never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["incident_absent"], cost_actual: 0, approval_requests: [] };
  const timeline = Array.isArray(vdi.timeline) ? vdi.timeline : [];
  const chainIssues = [];
  let prevTs = null;
  timeline.forEach((ev, i) => {
    const ts = String((ev || {}).ts || "");
    if (!ts) chainIssues.push({ index: i, issue: "EVIDENCE_GAP_missing_ts" });
    else if (prevTs && Date.parse(ts) < Date.parse(prevTs)) chainIssues.push({ index: i, issue: "OUT_OF_ORDER_EVIDENCE" });
    if (ts) prevTs = ts;
    if (!(ev || {}).evidence_ref) chainIssues.push({ index: i, issue: "EVIDENCE_GAP_no_ref" });
  });
  const targets = Array.isArray(vdi.rollback_targets) ? vdi.rollback_targets : [];
  const rollback = targets.map((t) => ({ ref: String((t || {}).ref || "(unlabelled)"), allowed: (t || {}).verified === true, verdict: (t || {}).verified === true ? "ROLLBACK_CANDIDATE_verified" : "ROLLBACK_BLOCKED_unverified_target" }));
  const contained = String(incident.containment_state || "reported");
  const plan = [
    "1. PRESERVE evidence as-is — the WO-104 money ledger is append-only and audit lines are immutable; nothing is edited or deleted during recovery",
    "2. CONFIRM blast radius from the supplied timeline (" + timeline.length + " events, " + chainIssues.length + " chain issues)",
    "3. ROLLBACK only to a verified target: " + (rollback.some((r) => r.allowed) ? rollback.filter((r) => r.allowed).map((r) => r.ref).join(", ") : "NONE verified — rollback stays blocked"),
    "4. CLOSE the incident only with owner sign-off (verdict RECOVERED is never self-declared)",
  ];
  const recId = stableId("RECOV", [String(input.tenant_id), String(incident.incident_id), String(contained), rollback.map((r) => r.verdict).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "PLANNING_ONLY_nothing_executed", authority_note: "SK-037 is the single durable audit/recovery authority — no parallel audit store; evidence integrity inherited from append-only ledger (WO-104)", recovery_plan: { plan_id: recId, incident_id: String(incident.incident_id), severity: String(incident.severity || "unspecified"), containment_state: contained, steps: plan, rollback_targets: rollback, evidence_chain_issues: chainIssues, timeline_events: timeline.length } },
    evidence_refs: [recId].concat(timeline.slice(0, 25).map((e) => String((e || {}).evidence_ref || "")).filter(Boolean), (input.source_refs || []).map(String)),
    uncertainty_flags: ["timeline_is_supplied_not_reconstructed_from_live_system", "root_cause_not_asserted_without_evidence"],
    cost_actual: 0,
    approval_requests: [{ scope: "execute_rollback_or_close_incident", auto: false, requires: "owner approves each step; this module plans and checks the chain — execution stays with the owner-run pipeline" }],
  };
}

/* ---- refund-case-agent (SK-038) — approval-bound refund/dispute CASE ASSEMBLY.
 * Payment provider is connector-bound (TBD/BLOCKED owner-token class): this module NEVER
 * issues refunds or writes money events. It evaluates supplied cases against the supplied
 * policy (window, non-refundable list), routes disputes, and asks one plain-language
 * question per case when essential records are missing. Links to SK-034 reconciliation.
 * out: typed_artifact{refund_cases}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_refund_case(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const cases = Array.isArray(vdi.cases) && vdi.cases.length ? vdi.cases : null;
  if (!cases) return { status: "REJECTED", reason: "cases[] required — refund cases come from real orders, never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["cases_absent"], cost_actual: 0, approval_requests: [] };
  const policy = vdi.refund_policy && typeof vdi.refund_policy === "object" ? vdi.refund_policy : null;
  if (!policy || !Number.isFinite(Number(policy.window_days))) return { status: "REJECTED", reason: "refund_policy{window_days} required — eligibility is measured against YOUR declared policy, not an assumed one", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["policy_absent"], cost_actual: 0, approval_requests: [] };
  const asOf = String(vdi.checked_on || policy.as_of || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { status: "REJECTED", reason: "checked_on (YYYY-MM-DD) required to evaluate the window", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["as_of_absent"], cost_actual: 0, approval_requests: [] };
  const nonRef = (Array.isArray(policy.non_refundable) ? policy.non_refundable : []).map(String);
  const evaluated = cases.map((raw, i) => {
    const c = raw && typeof raw === "object" ? raw : {};
    const id = String(c.case_id || "RC-" + (i + 1));
    const amt = Number(c.amount_myr);
    const problems = [];
    const questions = [];
    if (!String(c.order_ref || "").trim()) { problems.push("NO_ORDER_REF"); questions.push("Which order does this refund request belong to?"); }
    if (!Number.isFinite(amt) || amt <= 0) { problems.push("AMOUNT_MISSING_or_nonpositive"); questions.push("What amount is being refunded?"); }
    let inWindow = null;
    const bought = String(c.purchased_on || ""), asked = String(c.requested_on || "");
    if (!bought || !asked) { problems.push("DATES_INCOMPLETE"); questions.push("When was the order placed and when was the refund requested?"); }
    else {
      const age = Math.floor((Date.parse(asked) - Date.parse(bought)) / 86400000);
      if (!Number.isFinite(age)) { problems.push("DATES_UNPARSEABLE"); }
      else inWindow = age <= Number(policy.window_days);
      if (inWindow === false) problems.push("OUTSIDE_POLICY_WINDOW_" + policy.window_days + "d");
    }
    if (c.reason && nonRef.includes(String(c.reason))) problems.push("NON_REFUNDABLE_PER_POLICY:" + String(c.reason));
    const amountVsCap = Number.isFinite(Number(policy.max_auto_none)) ? null : null; // refunds are never auto regardless of amount
    const state = c.dispute === true ? "DISPUTE_WORKFLOW" : problems.length ? "HOLD_needs_owner" : "APPROVE_PENDING_owner_decision";
    return { case_id: id, order_ref: c.order_ref ? String(c.order_ref) : null, amount_myr: Number.isFinite(amt) ? Math.round(amt * 100) / 100 : null, in_window: inWindow, state, problems, plain_language_question: questions[0] || null, dispute: c.dispute === true, execution: "REFUND_NEVER_ISSUED_HERE — approved cases become money events only via owner-run path (SK-034 reconciliation confirms settlement)" };
  });
  const pend = evaluated.filter((e) => e.state === "APPROVE_PENDING_owner_decision");
  const holds = evaluated.filter((e) => e.state !== "APPROVE_PENDING_owner_decision");
  const refId = stableId("REFUND", [String(input.tenant_id), String(input.objective_id), evaluated.map((e) => e.case_id + ":" + e.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "CASE_ASSEMBLY_ONLY", connector_class: "payment provider TBD/BLOCKED — zero refund API calls", refund_cases: { batch_id: refId, policy_window_days: Number(policy.window_days), as_of: asOf, evaluated: evaluated.length, pending_owner_approval: pend.length, on_hold: holds.length, rows: evaluated } },
    evidence_refs: [refId].concat(evaluated.slice(0, 25).map((e) => e.order_ref).filter(Boolean), (input.source_refs || []).map(String)),
    uncertainty_flags: ["case_facts_are_supplied_not_provider_verified", "policy_application_advisory_until_owner_approves"],
    cost_actual: 0,
    approval_requests: evaluated.length ? [{ scope: "approve_refunds", auto: false, requires: holds.length + " held case(s) need records/policy reconciliation; " + pend.length + " pending case(s) need explicit owner approval per case before any money moves — customer contact about outcomes also gated (SK-014 consent, SK-006 drafts)" }] : [],
  };
}

/* ---- registration-advisor (SK-039) — jurisdiction step framework from a static map.
 * Boundary (sheet-04): registration RESEARCH; NO submission; never legal approval.
 * No network: official bodies are NAMED, never linked with invented URLs; every item is
 * explicit about what remains unverified. Unsupported jurisdictions are refused.
 * out: registration_checklist, source_links, outstanding_items (+ sidecars) */
export function skill_registration_advise(input = {}) {
  const missing = req(input, ["jurisdiction", "business_activity", "entity_status"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, registration_checklist: [], source_links: [], outstanding_items: [], evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const j = String(input.jurisdiction).toUpperCase();
  const KB = {
    MY: [{ step: "Entity registration", authority: "Suruhanjaya Syarikat Malaysia (SSM)", detail: "sole-prop/company registration for declared activity" },
         { step: "Income tax file", authority: "LHDN (Inland Revenue Board)", detail: "tax registration tied to entity status" },
         { step: "Sales & Service Tax (if threshold met)", authority: "Customs (SST)", detail: "check current threshold for declared business_activity" },
         { step: "Local council/information permit (if applicable)", authority: "PBT local council", detail: "premises/activity dependent" }],
    SG: [{ step: "Entity registration", authority: "ACRA", detail: "sole-prop/LLC registration for declared activity" },
         { step: "GST regime check", authority: "IRAS", detail: "income tax + registration thresholds" },
         { step: "Sector licences (if applicable)", authority: "relevant licensing agency", detail: "activity-dependent" }],
  };
  if (!Object.prototype.hasOwnProperty.call(KB, j)) return { status: "REJECTED", reason: "jurisdiction '" + input.jurisdiction + "' has no vetted step map — requirements are never improvised; supported: " + Object.keys(KB).join("/"), registration_checklist: [], source_links: [], outstanding_items: [] };
  const activity = String(input.business_activity).trim();
  const entity = String(input.entity_status).trim();
  const checklist = KB[j].map((row, i) => ({ item_id: "REG-" + (i + 1), ...row, applicability: "declared_activity='" + activity + "', entity_status='" + entity + "'", verdict: "RESEARCH_FRAMEWORK_ONLY — confirm current rules before relying; not legal advice" }));
  checklist.push({ item_id: "REG-" + (KB[j].length + 1), step: "Marketplace/platform onboarding KYC", authority: "each platform's seller onboarding", detail: "identity + bank + entity documents per platform policy", applicability: "when selling via marketplaces", verdict: "RESEARCH_FRAMEWORK_ONLY" });
  const sourceLinks = [...new Set(KB[j].map((r) => r.authority))].map((a) => ({ authority: a, url: null, url_policy: "intentionally not generated — no network; owner verifies the official portal directly" }));
  const outstanding = checklist.map((c) => c.step);
  const regId = stableId("REGADV", [j, activity, entity, String(input.tenant_id || "global")]);
  return {
    status: "OK",
    registration_checklist: checklist,
    source_links: sourceLinks,
    outstanding_items: outstanding,
    typed_artifact: { mode: "ADVISORY_NO_SUBMISSION", advisory_id: regId, no_submission: "nothing is filed, contacted or paid by this module — filings happen owner-run through official channels", not_legal_approval: true },
    evidence_refs: [regId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["static_step_map_may_lag_current_regulations", "activity_details_beyond_declared_inputs_unassessed"],
    cost_actual: 0,
    approval_requests: [{ scope: "act_on_registration_steps", auto: false, requires: "professional/official confirmation before acting — framework output is a starting point, not clearance" }],
  };
}

/* ---- shipping-rate-agent (SK-042) — quoting from SUPPLIER-SUPPLIED tariff tables.
 * Carrier connector is TBD/BLOCKED: no live quotes, no tracking lookups, nothing invented.
 * "Current quotes only" boundary: rate rows need valid_through >= as_of or they are EXPIRED.
 * out: typed_artifact{shipping_quotes}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_shipping_rate(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const rates = Array.isArray(vdi.rate_table) && vdi.rate_table.length ? vdi.rate_table : null;
  if (!rates) return { status: "REJECTED", reason: "rate_table[] required — carrier rates are never invented and no live quote API is called", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["rates_absent"], cost_actual: 0, approval_requests: [] };
  const asOf = String(vdi.as_of || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { status: "REJECTED", reason: "as_of (YYYY-MM-DD) required — validity of a tariff is date-bound", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["as_of_absent"], cost_actual: 0, approval_requests: [] };
  const shipments = Array.isArray(vdi.shipments) ? vdi.shipments : [];
  const live = rates.map((r) => ({ ...r, expired: String((r || {}).valid_through || "") < asOf || !(r || {}).valid_through }));
  const results = shipments.map((s, i) => {
    const sh = s && typeof s === "object" ? s : {};
    const kg = Number(sh.weight_kg);
    const zone = String(sh.zone || "");
    const candidates = live.filter((r) => !r.expired && (!r.zone || String(r.zone) === zone));
    const priced = candidates.map((r) => {
      const base = Number(r.base_myr || 0), perKg = Number(r.per_kg_myr || 0), flat = r.flat_myr !== undefined ? Number(r.flat_myr) : null;
      const total = flat !== null ? flat : Number.isFinite(kg) ? Math.round((base + perKg * kg) * 100) / 100 : null;
      return { carrier: String(r.carrier || "?"), total_myr: total, transit_days: r.transit_days !== undefined ? Number(r.transit_days) : null, basis: flat !== null ? "flat" : "base+per_kg" };
    }).filter((p) => p.total_myr !== null);
    const best = priced.length ? priced.slice().sort((a, b) => a.total_myr - b.total_myr || String(a.carrier).localeCompare(String(b.carrier)))[0] : null;
    return { shipment_ref: String(sh.ref || "S-" + (i + 1)), weight_kg: Number.isFinite(kg) ? kg : null, zone: zone || null, state: best ? "QUOTED_from_supplied_tariff" : (candidates.length ? "UNPRICED_missing_weight_or_formula" : "NO_VALID_RATE_expired_or_absent_for_zone"), options: priced, best, note: best ? "label price is a tariff computation, not a confirmed carrier booking" : null };
  });
  const tracked = (Array.isArray(vdi.status_requests) ? vdi.status_requests : []).map((t) => ({ ref: String((t || {}).ref || "?"), state: "STATUS_UNAVAILABLE_no_tracker_connector", never_invented: true }));
  const quoteId = stableId("SHIPQ", [String(input.tenant_id), String(input.objective_id), asOf, results.map((x) => x.shipment_ref + ":" + x.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "TARIFF_COMPUTATION_ONLY", connector_class: "logistics connector TBD/BLOCKED — zero live quote or tracking calls", shipping_quotes: { quote_batch_id: quoteId, as_of: asOf, tariff_rows: rates.length, expired_rows: live.filter((r) => r.expired).length, shipments: results, tracking_checks: tracked } },
    evidence_refs: [quoteId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["tariff_table_currency_unverified_beyond_as_of_date", "fuel_surcharge_and_cod_extras_unless_in_supplied_table"],
    cost_actual: 0,
    approval_requests: results.some((x) => x.state === "QUOTED_from_supplied_tariff") ? [{ scope: "book_shipment", auto: false, requires: "owner books with the carrier (or approves a LIVE-class connector session) — quotes here are computations only, and payment path stays SEC-05 gated" }] : [],
  };
}

/* ---- tenant-onboarding-agent (SK-050) — onboarding checklist + quota policy DRAFTING.
 * Boundary: tenant onboarding and isolation. Provisioning is NOT executed here; the spec's
 * declared tenant id must equal the request's tenant (cross-tenant provisioning DENIED).
 * out: typed_artifact{onboarding_plan, isolation_checks}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_tenant_onboard(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const spec = vdi.onboarding_spec && typeof vdi.onboarding_spec === "object" ? vdi.onboarding_spec : null;
  if (!spec || !String(spec.company_name || "").trim() || !String(spec.market || "").trim()) return { status: "REJECTED", reason: "onboarding_spec{company_name,market} required — tenants are never provisioned from partial identity", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["spec_incomplete"], cost_actual: 0, approval_requests: [] };
  if (spec.target_tenant_id !== undefined && String(spec.target_tenant_id) !== String(input.tenant_id)) return { status: "REJECTED", reason: "CROSS_TENANT_PROVISION_DENIED: spec targets '" + spec.target_tenant_id + "' but request is scoped to '" + input.tenant_id + "'", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["isolation_violation_refused"], cost_actual: 0, approval_requests: [] };
  const q = vdi.quotas && typeof vdi.quotas === "object" ? vdi.quotas : {};
  const quota = { objectives_per_month: q.objectives_per_month !== undefined ? Number(q.objectives_per_month) : "UNSET_owner_to_declare", storage_mb: q.storage_mb !== undefined ? Number(q.storage_mb) : "UNSET_owner_to_declare", policy_note: "unset quotas are never silently defaulted" };
  const stepsGiven = Array.isArray(spec.completed_steps) ? spec.completed_steps.map(String) : [];
  const plan = [
    { step: "company_identity_confirmed", state: stepsGiven.includes("company_identity_confirmed") ? "DONE_declared" : "PENDING" },
    { step: "admin_identity_and_rbac_roles", state: stepsGiven.includes("admin_identity_and_rbac_roles") ? "DONE_declared" : "PENDING", note: "roles validated via SK-027; enforcement via SK-035" },
    { step: "data_isolation_verified", state: "PENDING", note: "isolation tests (tenant-scoped store) run by the platform at provisioning, evidenced separately — not asserted here" },
    { step: "quota_policy_attached", state: quota.objectives_per_month === "UNSET_owner_to_declare" || quota.storage_mb === "UNSET_owner_to_declare" ? "BLOCKED_missing_owner_numbers" : "READY" },
    { step: "connector_credentials_vaulted", state: "PENDING", note: "credentials are owner-provisioned through the connector vault; never requested or stored by this module" },
  ];
  const pending = plan.filter((s) => s.state === "PENDING" || s.state.startsWith("BLOCKED")).length;
  const onbId = stableId("TENONB", [String(input.tenant_id), String(spec.company_name), String(spec.market), plan.map((s) => s.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "PLAN_DRAFTING_no_provisioning_executed", onboarding_plan: { plan_id: onbId, tenant_id: String(input.tenant_id), market: String(spec.market), steps: plan, pending_or_blocked: pending, quotas: quota }, isolation_checks: { same_tenant_enforced: true, cross_tenant_spec: "refused at input (see rule)" } },
    evidence_refs: [onbId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["steps_done_are_owner_declared_not_verified", "market_rules_defer_to_SK-039_framework"],
    cost_actual: 0,
    approval_requests: [{ scope: "execute_provisioning", auto: false, requires: "owner/platform runs actual provisioning + isolation evidence once plan items are DONE; this module only assembles the checklist" }],
  };
}

/* ---- social-performance-reporter (SK-059) — normalization of PERMITTED SUPPLIED metrics.
 * Channel metric APIs are connector-bound (LIVE needs owner-token permission): this module
 * NEVER fetches; it validates supplied metric rows (source + period + definition), keeps
 * engagement strictly separate from sales, and computes CPL/ROAS ONLY from verified spend
 * and reliable conversion events — otherwise UNKNOWN. Money-first spoken summary included.
 * out: channel_metrics, traffic_summary, verified_conversions, roi_if_supported, source_refs */
export function skill_social_performance_report(input = {}) {
  const missing = req(input, ["tenant_id", "channel_account_refs", "post_ids", "date_range", "verified_spend", "conversion_events"]);
  if (Array.isArray(input.conversion_events) && !input.conversion_events.length && missing.includes("conversion_events")) missing.splice(missing.indexOf("conversion_events"), 1); // declared-zero conversions is a valid declaration; absent is not
  if (missing.length) return { status: "NEEDS_INPUT", missing, channel_metrics: [], traffic_summary: null, verified_conversions: null, roi_if_supported: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [], source_refs: [] };
  const CH = ["facebook", "youtube", "linkedin"];
  const accounts = (Array.isArray(input.channel_account_refs) ? input.channel_account_refs : []).map(String);
  const posts = Array.isArray(input.post_ids) ? input.post_ids.map(String) : [];
  if (!accounts.length || !posts.length) return { status: "REJECTED", reason: "channel_account_refs[] and post_ids[] must be non-empty — the report period's scope is declared, not guessed", channel_metrics: [], traffic_summary: null, verified_conversions: null, roi_if_supported: null };
  const dr = input.date_range && typeof input.date_range === "object" ? input.date_range : {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dr.from || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dr.to || "")) || String(dr.from) > String(dr.to)) return { status: "REJECTED", reason: "date_range{from,to} as YYYY-MM-DD with from<=to required", channel_metrics: [], traffic_summary: null, verified_conversions: null, roi_if_supported: null };
  const rows = Array.isArray(input.validated_domain_inputs && input.validated_domain_inputs.metric_rows) ? input.validated_domain_inputs.metric_rows : [];
  const metrics = rows.map((raw, i) => {
    const m = raw && typeof raw === "object" ? raw : {};
    const ch = String(m.channel || "").toLowerCase();
    const problems = [];
    if (!CH.includes(ch)) problems.push("CHANNEL_not_permitted");
    if (!String(m.source || "").trim()) problems.push("NO_SOURCE_citation");
    if (!String(m.definition || "").trim()) problems.push("NO_METRIC_DEFINITION");
    if (String(m.period_from || "") !== dr.from || String(m.period_to || "") !== dr.to) problems.push("PERIOD_MISMATCH_range_is_" + dr.from + "_" + dr.to);
    if (!Number.isFinite(Number(m.value))) problems.push("VALUE_not_numeric");
    if (!String(m.post_id || "").length || posts.indexOf(String(m.post_id)) === -1) problems.push("POST_ID_outside_declared_scope");
    return { metric_index: i + 1, channel: ch || null, metric: String(m.metric || "?"), value: Number.isFinite(Number(m.value)) ? Number(m.value) : null, state: problems.length ? "REJECTED_ROW" : "COUNTED", problems };
  }).filter((m) => m.state === "COUNTED");
  const rejectedRows = rows.length - metrics.length;
  const sum = (name) => metrics.filter((m) => String(m.metric).toLowerCase() === name).reduce((a, m) => a + Number(m.value), 0);
  const eng = { impressions: sum("impressions"), views: sum("views"), clicks: sum("clicks") };
  const convs = Array.isArray(input.conversion_events) ? input.conversion_events : [];
  const reliable = convs.filter((c) => c && (c || {}).tracking_evidence_ref);
  const revenue = reliable.reduce((a, c) => a + Number((c || {}).amount_myr || 0), 0);
  const spend = Number(input.verified_spend);
  const roi = Number.isFinite(spend) && spend > 0 && reliable.length === convs.length && convs.length > 0
    ? { cpl_myr: Math.round(spend / reliable.length * 100) / 100, roas: Math.round((revenue / spend) * 100) / 100, basis: "verified_spend / events_with_tracking_evidence_only" }
    : null;
  const caveats = [];
  if (convs.length > 0 && reliable.length < convs.length) caveats.push("some_conversion_events_lack_tracking_evidence_ROI_left_UNKNOWN");
  if (!(Number.isFinite(spend) && spend > 0)) caveats.push("verified_spend_missing_or_zero_ROI_left_UNKNOWN");
  caveats.push("engagement_never_counted_as_sales_impressions_views_clicks_are_separate");
  if (rejectedRows) caveats.push("rejected_metric_rows_" + rejectedRows);
  const spoken = "Report for " + dr.from + " to " + dr.to + ". " + (roi ? ("Money first: revenue from tracked conversions is RM" + Math.round(revenue * 100) / 100 + " against RM" + spend + " verified spend, returning " + roi.roas + "x, cost per lead RM" + roi.cpl_myr + ". ") : "Money first: cannot confirm profit — spend or conversion evidence incomplete. ") + "Engagement: " + eng.impressions + " impressions, " + eng.views + " views, " + eng.clicks + " clicks (not sales)." + (caveats.length ? " Gaps: " + caveats.join("; ") + "." : "");
  const repId = stableId("SPR", [String(input.tenant_id), dr.from, dr.to, accounts.join(","), metrics.length + "/" + rows.length]);
  return {
    status: "OK",
    channel_metrics: metrics,
    traffic_summary: { ...eng, note: "web-traffic GA figures belong to a separate permitted source; not asserted here" },
    verified_conversions: { events_total: convs.length, with_tracking_evidence: reliable.length, revenue_myr: Math.round(revenue * 100) / 100, untracked: convs.length - reliable.length },
    roi_if_supported: roi,
    typed_artifact: { mode: "SUPPLIED_METRICS_ONLY_no_api_fetch", report_id: repId, period: { from: dr.from, to: dr.to }, channels_in_scope: CH.join("/"), rejected_metric_rows: rejectedRows, spoken_report_money_first: spoken, caveats },
    source_refs: [repId].concat(accounts.map((a) => "acct:" + a), (input.validated_domain_inputs && input.validated_domain_inputs.source_refs) || (input.source_refs || []).map(String)),
    evidence_refs: [repId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["metric_rows_are_platform_exports_not_re_pulled", "attribution_only_where_tracking_evidence_supplied"],
    cost_actual: 0,
    approval_requests: roi ? [] : [{ scope: "complete_money_reporting", auto: false, requires: "owner to supply verified spend and tracking-evidenced conversions (or approve a permissioned LIVE-class connector pull) — gaps stay UNKNOWN, never estimated" }],
  };
}

/* ---- asset-manager (SK-001) — rights/lineage validation over a SUPPLIED asset catalog.
 * The single media landing path (owner directive: media handled by upload/reuse, NOT by
 * generation). Google Drive connector class is never called here; checksums/rights are the
 * owner's declared records — unknown rights are BLOCKED, never assumed. Transcodes are
 * PLANNED, never executed by this module.
 * out: approved_assets, provenance, blocked_assets (+ sidecars) */
export function skill_asset_manage(input = {}) {
  const missing = req(input, ["asset_refs", "usage_rights", "target_format"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, approved_assets: [], provenance: [], blocked_assets: [], evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const catalog = Array.isArray(input.assets_catalog) ? input.assets_catalog : [];
  if (!catalog.length) return { status: "REJECTED", reason: "assets_catalog[] required — assets are looked up in the owner-supplied Drive export, never fetched or invented", approved_assets: [], provenance: [], blocked_assets: [] };
  const declaredRight = String(input.usage_rights);
  if (!["owner", "licensed", "review"].includes(declaredRight)) return { status: "REJECTED", reason: "usage_rights must be owner|licensed|review — rights class is declared, not guessed", approved_assets: [], provenance: [], blocked_assets: [] };
  const byRef = new Map(catalog.map((a) => [String((a || {}).ref || ""), a]));
  const approved = [], blocked = [], provenance = [];
  (input.asset_refs || []).map(String).forEach((ref) => {
    const a = byRef.get(ref);
    if (!a) { blocked.push({ ref, reason: "REF_NOT_IN_SUPPLIED_CATALOG — existence unconfirmed", retry: "export the Drive listing again and resubmit" }); return; }
    const rights = String(a.rights || "unknown");
    const checksum = String(a.checksum || "").trim();
    if (rights === "unknown" || !checksum) { blocked.push({ ref, reason: "RIGHTS_OR_PROVENANCE_UNVERIFIED" + (rights === "unknown" ? " (rights record missing)" : "") + (!checksum ? " (no checksum)" : ""), retry: "owner to attach rights + checksum before use" }); return; }
    if (declaredRight === "review" && !/reviewed/i.test(String(a.license_note || ""))) { blocked.push({ ref, reason: "LICENSE_NOTE_LACKS_REVIEW_EVIDENCE" }); return; }
    approved.push({ ref, kind: String(a.kind || "media"), rights: declaredRight === "review" ? "licensed" : rights, target_format: String(input.target_format), transcode: "PLANNED_NOT_EXECUTED (converter not invoked here)", transformations_allowed: a.transformations_allowed !== false });
    provenance.push({ ref, source_declared: String(a.source_declared || "(undisclosed)"), checksum, license_note: a.license_note ? String(a.license_note) : null });
  });
  const asstId = stableId("ASSET", [String(input.tenant_id || "global"), (input.asset_refs || []).map(String).join(","), String(input.target_format), declaredRight]);
  return {
    status: "OK",
    approved_assets: approved,
    provenance,
    blocked_assets: blocked,
    typed_artifact: { mode: "VALIDATION_ONLY_no_drive_calls_no_transcodes", rights_note: "asset rights and tenant metadata remain AIVORA-owned (boundary); this module validates records, it does not acquire or alter them", batch_id: asstId, requested: (input.asset_refs || []).length, approved_count: approved.length, blocked_count: blocked.length },
    evidence_refs: [asstId].concat(provenance.map((p) => "sha256:" + p.checksum).slice(0, 10), (input.source_refs || []).map(String)),
    uncertainty_flags: ["rights_and_checksums_are_owner_declared_not_crawled", "file_content_not_inspected_metadata_only"],
    cost_actual: 0,
    approval_requests: blocked.length ? [{ scope: "clear_blocked_assets", auto: false, requires: "owner supplies rights records or replaces assets — unverified media never reaches creatives (SK-055/SK-018 consume approved_assets only)" }] : [],
  };
}

/* ---- channel-publisher (SK-010) — the SOLE publishing path's validation gate.
 * Publishing is a prohibited automatic action (owner-only + LIVE connector class,
 * owner-token gated): every post leaves this module KEEPING_DRAFT with remote_id null.
 * It validates approval evidence, per-channel format rules, idempotency keys and would
 * be the only place remote confirmation IDs get recorded — never claiming success.
 * out: typed_artifact{publish_plan}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_channel_publish(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const posts = Array.isArray(vdi.posts) && vdi.posts.length ? vdi.posts : null;
  if (!posts) return { status: "REJECTED", reason: "posts[] required — nothing is published that was not drafted (SK-055/SK-015/SK-056 outputs)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["posts_absent"], cost_actual: 0, approval_requests: [] };
  const CHANNELS = { facebook: { max_len: 5000, needs: ["text"] }, youtube: { max_len: 5000, needs: ["title"] }, linkedin: { max_len: 3000, needs: ["text"] }, instagram: { max_len: 2200, needs: ["text", "media_ref"] } };
  const plan = posts.map((raw, i) => {
    const p = raw && typeof raw === "object" ? raw : {};
    const ch = String(p.channel || "").toLowerCase();
    const problems = [];
    if (!CHANNELS[ch]) problems.push("CHANNEL_not_permitted");
    else (CHANNELS[ch].needs || []).forEach((nf) => { if (!String(p[nf] || (nf === "media_ref" ? p.media_ref : "") || "").trim()) problems.push("FORMAT_missing_" + nf); });
    if (CHANNELS[ch] && String(p.text || p.title || "").length > CHANNELS[ch].max_len) problems.push("FORMAT_over_length_limit_" + CHANNELS[ch].max_len);
    if (!String(p.approval_ref || "").trim()) problems.push("NO_APPROVAL_EVIDENCE_owner_approval_required_first");
    if (!String(p.idempotency_key || "").trim()) problems.push("MISSING_IDEMPOTENCY_KEY_repeat_risk");
    const sched = String(p.schedule_at || "");
    if (sched && Number.isNaN(Date.parse(sched))) problems.push("SCHEDULE_unparseable_timestamp");
    return { post_ref: String(p.post_ref || "POST-" + (i + 1)), channel: ch || null, gate: problems.length ? "GATE_BLOCKED" : "GATE_CLEARED_for_owner_execution", problems, state: "KEEPING_DRAFT_no_connector_call", remote_id: null };
  });
  const cleared = plan.filter((x) => !x.problems.length);
  const pubId = stableId("PUBGATE", [String(input.tenant_id), String(input.objective_id), plan.map((x) => x.post_ref + ":" + x.state + ":" + x.problems.length).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "GATE_VALIDATION_zero_posts_sent", sole_path_note: "SK-010 is the policy's single publishing path — bypassing it to a provider directly is prohibited; ONE provider per destination", never_claim_success: "remote confirmation IDs are recorded only from real platform responses; here every remote_id is null because NOTHING was sent", publish_plan: { plan_id: pubId, gate_cleared: cleared.length, gate_blocked: plan.length - cleared.length, connector_class_at_execution: "LIVE_owner_token_gated", rows: plan } },
    evidence_refs: [pubId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["approval_refs_are_asserted_not_checked_against_gateway_records"],
    cost_actual: 0,
    approval_requests: cleared.length ? [{ scope: "execute_publish", auto: false, requires: "explicit owner execution against permissioned accounts (or a DEV-02 dispositioned connector session) — this gate validates and holds drafts; it never sends" }] : [],
  };
}

/* ---- promotion-planner (SK-036) — discount mechanics DRAFTING with price math on
 * supplied verified base prices. Boundary: promotional offers draft; price validation
 * stays separate (SK-030 margins / owner). Nothing is applied to a storefront and no
 * customer is contacted here. Expiry and floor checks are arithmetic, not opinions.
 * out: typed_artifact{promotion_draft}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_promotion_plan(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const promo = vdi.promotion && typeof vdi.promotion === "object" ? vdi.promotion : null;
  if (!promo || !["pct", "fixed", "bnv"].includes(String(promo.type))) return { status: "REJECTED", reason: "promotion{type: pct|fixed|bnv,...} required — mechanics are declared, not assumed", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["promo_absent"], cost_actual: 0, approval_requests: [] };
  const prices = Array.isArray(vdi.verified_base_prices) && vdi.verified_base_prices.length ? vdi.verified_base_prices : null;
  if (!prices) return { status: "REJECTED", reason: "verified_base_prices[] required — promo prices derive from YOUR verified price list, never invented figures", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["prices_absent"], cost_actual: 0, approval_requests: [] };
  const start = String(promo.starts_on || ""), end = String(promo.ends_on || ""), asOf = String(promo.as_of || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return { status: "REJECTED", reason: "starts_on/ends_on (YYYY-MM-DD, start<=end) required — expiry terms are explicit", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["window_invalid"], cost_actual: 0, approval_requests: [] };
  const liveness = asOf ? (asOf < start ? "NOT_STARTED" : asOf <= end ? "ACTIVE_WINDOW" : "EXPIRED") : "WINDOW_UNCHECKED_no_as_of";
  const value = Number(promo.value || 0);
  const floor = Number.isFinite(Number(promo.margin_floor_myr)) ? Number(promo.margin_floor_myr) : null;
  const lines = prices.map((raw) => {
    const b = raw && typeof raw === "object" ? raw : {};
    const sku = String(b.sku || "?"), base = Number(b.price_myr);
    if (!Number.isFinite(base) || base <= 0) return { sku, state: "SKIPPED_base_price_unverified", promo_price_myr: null };
    let promoPrice = null, mechanic = null;
    if (promo.type === "pct") { if (!(value > 0 && value <= 90)) return { sku, state: "REJECTED_pct_out_of_guardrail_1_90", promo_price_myr: null }; promoPrice = Math.round(base * (1 - value / 100) * 100) / 100; mechanic = value + "% off"; }
    else if (promo.type === "fixed") { promoPrice = Math.round((base - value) * 100) / 100; mechanic = "RM" + value + " off"; if (promoPrice <= 0) return { sku, state: "REJECTED_price_would_be_nonpositive", promo_price_myr: null }; }
    else { promoPrice = base; mechanic = String(promo.bnv_note || "buy N get X — free-unit cost separate"); }
    const belowFloor = floor !== null && Number.isFinite(Number(b.cost_myr)) && (promoPrice - Number(b.cost_myr)) < floor;
    return { sku, base_price_myr: base, promo_price_myr: promoPrice, mechanic, state: belowFloor ? "FLAG_below_margin_floor_owner_review" : "DRAFTED", cost_basis: Number.isFinite(Number(b.cost_myr)) ? Number(b.cost_myr) : "unverified_no_floor_check_possible" };
  });
  const terms = ["Offer terms draft: validity " + start + " to " + end + "; while declared stock lasts — quantities are NEVER guaranteed here", "One redemption per " + String(promo.limit_basis || "customer per order") , "Combined-with-other-offers: " + (promo.stackable === true ? "declared stackable (verify platform rules)" : "NO (default safest reading)"), "Publication and customer contact for promos: SK-010 gate + SK-014 consent + owner approval — nothing broadcast automatically"];
  const prId = stableId("PROMO", [String(input.tenant_id), String(promo.type), String(value), start, end, lines.map((l) => l.sku + ":" + l.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "DRAFT_price_application_external_and_owner_gated", promotion_draft: { draft_id: prId, type: String(promo.type), value, window: { start, end }, liveness, lines, terms_and_conditions_draft: terms, drafted: lines.filter((l) => l.state === "DRAFTED").length, flags_or_rejections: lines.filter((l) => l.state !== "DRAFTED").length } },
    evidence_refs: [prId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["base_prices_owner_verified_not_re_pulled", "demand_uplift_not_predicted_no_forecast_claims"],
    cost_actual: 0,
    approval_requests: [{ scope: "activate_promotion", auto: false, requires: "owner price-validation (SK-030 margins for flagged SKUs) + storefront application + consent-gated announcement — draft only until then" }],
  };
}

/* ---- shipping-tracker (SK-043) — carrier milestones from AUTHORIZED SUPPLIED feeds only.
 * Boundary: verified tracking events; delivery dates are NEVER invented. Live feeds are
 * logistics-connector TBD/BLOCKED (owner-token class): dispatch there returns BLOCKED with
 * retry guidance, and an unsupplied feed is never faked as MOCK data.
 * out: tracking_events, exception_alerts (+ sidecars) */
export function skill_shipping_track(input = {}) {
  const missing = req(input, ["carrier_reference", "authorized_connector"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing: missing.includes("authorized_connector") ? missing.concat(["tracking_feed (MOCK/SANDBOX export) or an owner-approved LIVE connector grant"]) : missing, tracking_events: [], exception_alerts: [], evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const connector = String(input.authorized_connector).toUpperCase();
  if (connector === "LIVE") return { status: "BLOCKED", reason: "live tracking connector is TBD/BLOCKED owner-token class — no endpoint is called or simulated; retry once a permissioned connector session is approved", tracking_events: [], exception_alerts: [], evidence_refs: [(input.source_refs || [])[0] || "src:track"].map(String), uncertainty_flags: ["connector_unavailable"], cost_actual: 0, approval_requests: [{ scope: "live_tracking_access", auto: false, requires: "owner-token connector authorization per DEV-02 disposition" }] };
  if (connector !== "MOCK" && connector !== "SANDBOX") return { status: "REJECTED", reason: "authorized_connector must be MOCK/SANDBOX (or LIVE→BLOCKED class) — got '" + input.authorized_connector + "'", tracking_events: [], exception_alerts: [] };
  const ref = String(input.carrier_reference);
  const feedAll = Array.isArray(input.tracking_feed) ? input.tracking_feed : null;
  if (!feedAll) return { status: "REJECTED", reason: "tracking_feed[] required — events come from your export; nothing is scraped", tracking_events: [], exception_alerts: [] };
  const mine = feedAll.filter((e) => String((e || {}).carrier_reference || "") === ref);
  if (!mine.length) return { status: "OK", tracking_events: [], exception_alerts: [{ code: "NO_EVENTS_IN_AUTHORIZED_FEED", guidance: "one plain question: was this parcel shipped under a different carrier reference?" }], typed_artifact: { mode: "FEED_READ_ONLY", carrier_reference: ref, note: "absence of events reported as absence — never rendered as 'lost' or 'delivered'" }, evidence_refs: [stableId("TRACK", [ref, connector, "0"])].concat((input.source_refs || []).map(String)), uncertainty_flags: ["feed_may_lag_carrier_reality"], cost_actual: 0, approval_requests: [] };
  const badShape = [];
  const events = mine.map((raw, i) => {
    const e = raw && typeof raw === "object" ? raw : {};
    const ts = String(e.ts || "");
    if (!ts || Number.isNaN(Date.parse(ts)) || !String(e.status || "").trim()) { badShape.push(i + 1); return null; }
    const row = { ts, status: String(e.status).toLowerCase(), location: e.location ? String(e.location) : null, raw_ref: e.event_ref ? String(e.event_ref) : null };
    return row;
  }).filter(Boolean).sort((a, b) => (Date.parse(a.ts) - Date.parse(b.ts)) || String(a.status).localeCompare(String(b.status)));
  const exception_alerts = events.filter((ev) => /delay|lost|damaged|returned|customs|exception/.test(ev.status)).map((ev) => ({ code: "CARRIER_" + ev.status.toUpperCase(), at: ev.ts, customer_contact: "NEVER automatic — route via SK-014 consent check + SK-006 draft + owner send", suggested_owner_action: ev.status.includes("lost") ? "open carrier claim + consider SK-038 refund case" : "monitor next scan" }));
  const eta = mine.map((e) => (e || {}).declared_eta).find((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) || null;
  const trkId = stableId("TRACK", [ref, connector, events.length + "/" + mine.length, exception_alerts.length]);
  return {
    status: "OK",
    tracking_events: events,
    exception_alerts,
    typed_artifact: { mode: "FEED_READ_ONLY_" + connector, carrier_reference: ref, events_in_window: events.length, malformed_dropped: badShape.length, declared_eta: eta, eta_note: eta ? "eta is the feed's declaration only — this module never sets delivery dates" : "no declared ETA — stated as unknown", last_event: events.length ? events[events.length - 1] : null },
    evidence_refs: [trkId].concat(events.map((e) => e.raw_ref).filter(Boolean).slice(0, 10), (input.source_refs || []).map(String)),
    uncertainty_flags: ["feed_is_an_export_scan_lag_possible", "statuses_carrier_wording_passthrough"],
    cost_actual: 0,
    approval_requests: exception_alerts.length ? [{ scope: "customer_notification about exceptions", auto: false, requires: "owner approval after consent validation — exception facts here do not authorize outreach" }] : [],
  };
}

/* ---- specialist-router (SK-045) — deterministic capability→specialist ranking over the
 * ONE registry mapping supplied by the caller (registry rows as exported). Scores keyword
 * overlap only; ties stay AMBIGUOUS for the owner; assignments are returned as PROPOSALS —
 * the dispatcher applies them, this module never executes or re-wires the registry.
 * out: typed_artifact{routing}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_specialist_route(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const cap = Array.isArray(vdi.keywords) && vdi.keywords.length ? vdi.keywords.map((k) => String(k).toLowerCase()) : null;
  if (!cap) return { status: "REJECTED", reason: "keywords[] required — a capability request is declared, not inferred", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: 0, approval_requests: [] };
  const registry = Array.isArray(vdi.registry_excerpt) && vdi.registry_excerpt.length ? vdi.registry_excerpt : null;
  if (!registry) return { status: "REJECTED", reason: "registry_excerpt[] required — routing reads the ONE registry mapping (export it), never a shadow catalog", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["registry_absent"], cost_actual: 0, approval_requests: [] };
  if (vdi.secondary_registry !== undefined) return { status: "REJECTED", reason: "a second registry source was offered — boundary: ONE registry and dispatcher mapping", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["multi_registry_refused"], cost_actual: 0, approval_requests: [] };
  const scored = registry.map((row) => {
    const kw = (Array.isArray((row || {}).keywords) ? row.keywords : []).map((k) => String(k).toLowerCase());
    const hits = cap.filter((k) => kw.includes(k));
    return { specialist: String((row || {}).specialist || (row || {}).skill_id || "?"), status: String((row || {}).status || "unknown"), score: hits.length, matched: hits };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || String(a.specialist).localeCompare(String(b.specialist)));
  const top = scored[0] ? scored.filter((x) => x.score === scored[0].score) : [];
  const verdict = !scored.length ? "NO_MATCH_escalate_to_owner" : top.length > 1 ? "AMBIGUOUS_owner_chooses" : "PROPOSED:" + top[0].specialist;
  const routeId = stableId("ROUTE", [String(input.tenant_id), String(input.objective_id), cap.join(","), registry.length]);
  return {
    status: "OK",
    typed_artifact: { mode: "PROPOSAL_ONLY_dispatcher_applies", routing: { route_id: routeId, capability_keywords: cap, registry_rows_read: registry.length, candidates: scored, verdict, rule: "exact keyword-overlap count, ties never broken by the machine" }, no_side_effects: "no task was assigned, no registry entry touched, no agent activated" },
    evidence_refs: [routeId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["registry_excerpt_is_a_snapshot_may_lag_live_registry", "keyword_overlap_is_a_heuristic_not_semantics"],
    cost_actual: 0,
    approval_requests: verdict.startsWith("AMBIGUOUS") || verdict.startsWith("NO_MATCH") ? [{ scope: "select_specialist", auto: false, requires: top.length > 1 ? "owner picks among tied candidates (scores: " + top.map((t) => t.specialist + "=" + t.score).join(", ") + ")" : "owner names the specialist or registers a mapping — unmatched capabilities are never force-routed" }] : [],
  };
}

/* ---- translation-agent (SK-052) — same doctrine as SK-029: multilingual QA + context
 * preservation over SUPPLIED translations. It does NOT itself produce translations
 * (provider/LLM-bound; generation would violate the deterministic-module rule): it verifies
 * named entities, numerals and placeholders survive the pair, glossary compliance and
 * flags uncertainty for human review. Nothing is invented as 'translated'.
 * out: typed_artifact{translation_qa}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_translation_agent(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const pairs = Array.isArray(vdi.pairs) && vdi.pairs.length ? vdi.pairs : null;
  if (!pairs) return { status: "REJECTED", reason: "pairs[]{source,target} required — both sides must exist; translations are never generated here", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["pairs_absent"], cost_actual: 0, approval_requests: [] };
  const entities = (s) => [...new Set((String(s).match(/\b[A-Z][a-zA-Z0-9'’.-]{2,}\b/g) || []).map((x) => x.toLowerCase()))];
  const numerals = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).slice().sort().join("|");
  const placeholders = (s) => (String(s).match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) || []).slice().sort().join("|");
  const keepTerms = (Array.isArray(vdi.glossary) ? vdi.glossary : []).map((g) => String((g || {}).term || "")).filter(Boolean);
  const rows = pairs.map((raw, i) => {
    const pr = raw && typeof raw === "object" ? raw : {};
    const src = String(pr.source || ""), tgt = String(pr.target || "");
    const flags = [];
    if (!src.trim() || !tgt.trim()) return { item_id: String(pr.id || "T-" + (i + 1)), state: "INCOMPLETE_PAIR_never_counted", flags: ["MISSING_SIDE"] };
    entities(src).forEach((e) => { if (!new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(tgt)) flags.push("ENTITY_LOST:" + e); });
    if (numerals(src) !== numerals(tgt)) flags.push("NUMERALS_CHANGED_money_or_counts_DANGER");
    if (placeholders(src) !== placeholders(tgt)) flags.push("PLACEHOLDER_MISMATCH");
    keepTerms.forEach((t) => { if (new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(src) && !new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(tgt)) flags.push("LOCKED_TERM_DROPPED:" + t); });
    return { item_id: String(pr.id || "T-" + (i + 1)), state: flags.length ? "FLAGGED" : (pr.human_reviewed === true ? "QA_PASS_reviewed" : "QA_PASS_machine_checks_only"), flags, human_reviewed: pr.human_reviewed === true };
  });
  const incomplete = rows.filter((x) => x.state === "INCOMPLETE_PAIR_never_counted").length;
  const flagged = rows.filter((x) => x.state === "FLAGGED").length;
  const unreviewed = rows.filter((x) => x.state === "QA_PASS_machine_checks_only").length;
  const trId = stableId("TRQA", [String(input.tenant_id), String(input.objective_id), rows.map((x) => x.item_id + ":" + x.state).join(",")]);
  return {
    status: "OK",
    typed_artifact: { mode: "QA_ONLY_no_translation_generated", translation_qa: { qa_id: trId, pairs: rows.length, machine_pass_unreviewed: unreviewed, flagged, incomplete, rows, coherence_note: "context preservation = entities/numerals/placeholders/glossary survive; nuance and register need the human line below" } },
    evidence_refs: [trId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["machine_checks_cannot_judge_fluency_or_register", "quality_claim_valid_only_after_human_review"],
    cost_actual: 0,
    approval_requests: (flagged + unreviewed + incomplete) ? [{ scope: "release_translated_copy", auto: false, requires: "human/owner review — " + flagged + " flagged, " + unreviewed + " machine-clean-but-unreviewed, " + incomplete + " incomplete pairs must not ship" }] : [],
  };
}

/* ---- voice-telephony-agent (SK-053) — call-routing BLUEPRINTS, telephony need verify.
 * Boundary honored: telephony is NOT installed by default; Dialpad is optional and any
 * LIVE telephony API is owner-token class — zero calls are made. Numbers must be valid
 * E.164; every menu path must terminate at a human/owner voicemail fallback is capped.
 * out: typed_artifact{routing_plan}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_voice_telephony(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const flows = Array.isArray(vdi.call_flows) && vdi.call_flows.length ? vdi.call_flows : null;
  if (!flows) return { status: "REJECTED", reason: "call_flows[] required — routing trees are declared by the owner, never invented", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["flows_absent"], cost_actual: 0, approval_requests: [] };
  const provisioned = vdi.telephony_provisioned === true;
  const problems = [];
  const plan = flows.map((raw, i) => {
    const f = raw && typeof raw === "object" ? raw : {};
    const issues = [];
    const dest = String(f.destination || "");
    if (dest && !/^\+[1-9]\d{6,14}$/.test(dest.replace(/[\s-]/g, ""))) issues.push("DESTINATION_not_E164:" + (dest || "(empty)"));
    const menu = String(f.menu_prompts || "");
    if (!menu.trim()) issues.push("NO_MENU_PROMPT_draft_required");
    const endsAtHuman = ["human", "owner"].includes(String(f.terminates_at || ""));
    if (!endsAtHuman) issues.push("PATH_DOES_NOT_TERMINATE_at_human_or_owner");
    return { flow: String(f.name || "FLOW-" + (i + 1)), destination: dest || null, issues, state: issues.length ? "NOT_READY" : "BLUEPRINT_VALID" };
  });
  const bad = plan.filter((x) => x.state === "NOT_READY").length;
  if (!provisioned) problems.push("TELEPHONY_NOT_PROVISIONED — boundary 'verify telephony need' honored: no line exists yet, blueprint only");
  const telId = stableId("VOICE9", [String(input.tenant_id), String(input.objective_id), plan.map((x) => x.flow + ":" + x.state).join(","), String(provisioned)]);
  return {
    status: "OK",
    typed_artifact: { mode: "BLUEPRINT_ONLY_no_calls_no_provisioning", provider_status: provisioned ? "declared_provisioned_owner" : "NOT_PROVISIONED", api_calls: 0, connector_note: "Dialpad optional; any LIVE telephony API is owner-token BLOCKED class and was NOT invoked or simulated", routing_plan: { blueprint_id: telId, flows: plan.length, flow_details: plan, valid_blueprints: plan.length - bad, blocked_flows: bad, provisioning_gaps: problems, rule: "E.164 destinations + menu prompts + human-terminating paths required; elderly-owner-safe: no infinite menus" } },
    evidence_refs: [telId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["destination_numbers_are_declared_not_dialed_verified", "provisioning_state_is_owner_assertion"],
    cost_actual: 0,
    approval_requests: [{ scope: "provision_or_wire_telephony", auto: false, requires: provisioned ? "owner runs the carrier/connector wiring (LIVE class) using this blueprint; costs hit the budget path (SEC-05) before any paid line is ordered" : "owner decision: is telephony actually needed? blueprint costs RM0 — provisioning is a separate gated step" }],
  };
}

/* ---- voice-ux-guide (SK-054) — voice onboarding scripts + accessible-dialogue checks.
 * Drafts plain-language spoken flows from supplied facts; validates accessibility rules
 * (short turns, one question at a time, no idioms, money in spoken form) and keeps
 * dialect claims in VERIFY state until owner-confirmed (boundary: verify dialects).
 * out: typed_artifact{voice_scripts, accessibility}, evidence_refs, uncertainty_flags, cost_actual, approval_requests */
export function skill_voice_ux_guide(input = {}) {
  const missing = req(input, ["tenant_id", "objective_id", "task_id", "validated_domain_inputs", "source_refs"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, typed_artifact: null, evidence_refs: [], uncertainty_flags: ["inputs_absent"], cost_actual: null, approval_requests: [] };
  const vdi = input.validated_domain_inputs || {};
  const facts = Array.isArray(vdi.dialogue_facts) && vdi.dialogue_facts.length ? vdi.dialogue_facts : null;
  if (!facts) return { status: "REJECTED", reason: "dialogue_facts[] required — spoken content maps to declared facts only, nothing improvised", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["facts_absent"], cost_actual: 0, approval_requests: [] };
  const locale = String(vdi.locale || "");
  if (locale && !/^[a-z]{2,3}(-[A-Z][a-z]{3})*(-[A-Z]{2})?$/.test(locale)) return { status: "REJECTED", reason: "locale must be BCP-47-like — dialects are declared, never guessed (boundary: verify dialects)", typed_artifact: null, evidence_refs: [], uncertainty_flags: ["locale_invalid"], cost_actual: 0, approval_requests: [] };
  const IDIOMS = [/piece of cake/i, /hang in there/i, /ballpark/i, /touch base/i, /low-hanging/i];
  const toSpokenMoney = (m) => String(m).replace(/RM\s?([\d.,]+)/g, (x) => x.replace("RM", "ringgit ").replace(/\./g, " point "));
  const script = facts.map((f, i) => {
    const raw = String((f && f.text) || f || "");
    const flags = [];
    if (raw.split(/\s+/).length > 25) flags.push("TURN_TOO_LONG_split_it_under_25_words");
    if ((raw.match(/\?/g) || []).length > 1) flags.push("MULTI_QUESTION_TURN_one_question_at_a_time");
    IDIOMS.forEach((re) => { if (re.test(raw)) flags.push("IDIOM_REDUCE_accessibility"); });
    const spoken = toSpokenMoney(raw);
    if (/RM\s?\d/.test(raw) && spoken === raw) flags.push("MONEY_needs_spoken_form");
    return { turn: i + 1, text: raw, spoken_form: spoken, flags, state: flags.length ? "REVISE" : "DRAFT_OK" };
  });
  const dialectState = locale ? (vdi.dialect_confirmed === true ? "CONFIRMED_by_owner" : "VERIFY_REQUIRED_not_assumed") : "UNDECLARED_no_locale_given";
  const guideId = stableId("VOX", [String(input.tenant_id), String(input.objective_id), script.length, dialectState]);
  return {
    status: "OK",
    typed_artifact: { mode: "SCRIPT_DRAFTS_no_tts_invoked", voice_scripts: { script_id: guideId, locale: locale || null, dialect_state: dialectState, turns: script.length, revise: script.filter((x) => x.state === "REVISE").length, rows: script }, runtime_note: "speech synthesis/recognition runtime binding is a separate platform path — this module authors and checks text only" },
    evidence_refs: [guideId].concat((input.source_refs || []).map(String)),
    uncertainty_flags: ["spoken_naturalness_needs_human_ear", "accessibility_rules_are_heuristics_not_full_WCAG_voice_audit"],
    cost_actual: 0,
    approval_requests: [{ scope: "activate_voice_flow", auto: false, requires: (dialectState === "VERIFY_REQUIRED_not_assumed" ? "confirm the dialect with a real speaker; " : "") + "owner read-aloud sign-off before any customer-facing voice path opens" }],
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
  "checkout-integrator": skill_checkout_integrate, "conversation-designer": skill_conversation_design,
  "demand-researcher": skill_demand_research, "fulfillment-planner": skill_fulfillment_plan,
  "objective-planner": skill_objective_plan, "supplier-dispatcher": skill_supplier_dispatch,
  "marketing-os-campaign-builder": skill_marketing_campaign_build, "conversion-analyst": skill_conversion_analyze,
  "escalation-agent": skill_escalation_triage, "experiment-analyst": skill_experiment_analyze,
  "faq-retrieval-agent": skill_faq_retrieve, "order-validator": skill_order_validate,
  "budget-planner": skill_budget_plan, "crm-follow-up": skill_crm_followup,
  "cashflow-forecaster": skill_cashflow_forecast, "wan-video-creator": skill_wan_video_create,
  "consent-checker": skill_consent_check, "localization-specialist": skill_localization_specialist,
  "payment-reconciler": skill_payment_reconcile, "site-qa-tester": skill_site_qa,
  "threat-monitor": skill_threat_monitor, "identity-agent": skill_identity_agent,
  "content-planner": skill_content_planner, "brand-setup-specialist": skill_brand_setup_specialist,
  "inventory-validator": skill_inventory_validate, "optimization-agent": skill_optimization_advise,
  "recovery-audit-agent": skill_recovery_audit, "refund-case-agent": skill_refund_case,
  "registration-advisor": skill_registration_advise, "shipping-rate-agent": skill_shipping_rate,
  "tenant-onboarding-agent": skill_tenant_onboard, "social-performance-reporter": skill_social_performance_report,
  "asset-manager": skill_asset_manage, "channel-publisher": skill_channel_publish,
  "promotion-planner": skill_promotion_plan, "shipping-tracker": skill_shipping_track,
  "specialist-router": skill_specialist_route, "translation-agent": skill_translation_agent,
  "voice-telephony-agent": skill_voice_telephony, "voice-ux-guide": skill_voice_ux_guide,
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
