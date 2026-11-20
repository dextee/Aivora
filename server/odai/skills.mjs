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
import { appendMoneyEvent, moneyEvents, moneyTotals } from "./ledger.mjs";
import { loadSkillContract } from "./registry.mjs";

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
 * itself untouched.
 * in : actor, tenant, action, resource, risk, gate?{scope}, owner_approved?, amount_myr?, cap_myr?
 * out: policy_decision, reason_code, obligations (+envelope sidecars) */
export function skill_gate_check(input = {}) {
  const missing = req(input, ["actor", "tenant", "action", "resource", "risk"]);
  if (missing.length) return { status: "NEEDS_INPUT", missing, policy_decision: "DENY", reason_code: "inputs_absent", obligations: [] };
  const gate = input.gate || null;
  const scope = gate ? String(gate.scope) : null;
  let policy_decision = "ALLOW"; let reason_code = "within_allowed_actions";
  const obligations = ["log decision", "tenant-scoped record only"];
  if (scope === "spend") {
    const cap = Number(input.cap_myr || 0);
    const ask = Number(input.amount_myr || 0);
    if (!input.owner_approved) { policy_decision = "HOLD"; reason_code = "AWAITING_SPEND_APPROVAL"; }
    else if (cap && ask > cap) { policy_decision = "BLOCK"; reason_code = "OVER_HARD_CAP_" + cap; }
    else { policy_decision = "ALLOW"; reason_code = "owner_approved_within_cap"; }
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
    typed_artifact: { policy_decision, reason_code, action: String(input.action) },
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

export const P0_SKILL_FUNCTIONS = {
  "ledger-append": skill_ledger_append, "catalog-query": skill_catalog_query, "evidence-append": skill_evidence_append,
  "gate-check": skill_gate_check, "schedule-scaffold": skill_schedule_scaffold, "report-compose": skill_report_compose,
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
