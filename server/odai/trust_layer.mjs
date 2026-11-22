/* AIVORA RogueAI Shield — Neurosymbolic Trust Layer + Numerical/Symbolic Guardrail Engine.
 * LLMs propose; this layer decides. Independent, deterministic, persistent.
 * - Persistent versioned rule registry (disk), owner-only modification, audit history, rollback.
 * - Deterministic decimal (integer-cents) numerical evaluation; missing mandatory fact => BLOCKED_MISSING_EVIDENCE.
 * - Severity -> enforcement (INFORMATIONAL/WARNING/REQUIRE_APPROVAL/DENY/CONTAIN/ESCALATE).
 * - Dual-LLM failure test: both LLMs "approve" a prohibited action; this layer still denies via real rules.
 * - Persists sanitized evaluation evidence (proposal, LLM assessments, thresholds, observed values,
 *   passed/failed constraints, final decision, policy version, outcome, incident ref).
 * Reuses policy.mjs, store_config frozen URLs, customers incidents/quarantine. Does NOT replace them. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PAYPAL_PAYMENT_URL, HASHMETA_STORE_URL } from "./store_config.mjs";
import { POLICY_VERSION } from "./policy.mjs";

const dir = fileURLToPath(new URL("../../odai/data/trust/", import.meta.url));
const RULES = dir + "rules.json";
const EVALS = dir + "evaluations.jsonl";
const CHANGES = dir + "changes.json";
const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const cents = v => Math.round(v * 100);
export const TRUST_VERSION = "trust-1.0+" + POLICY_VERSION;

/* §5 mandatory financial defaults + category guardrails (sandbox defaults until owner-approved). */
function seedRules() {
  const now = new Date().toISOString();
  const base = (id, name, category, type, op, threshold, unit, severity, enforcement, facts, expr, skills, desc) => ({
    rule_id: id, rule_name: name, rule_category: category, description: desc, rule_type: type,
    comparison_operator: op, threshold_value: threshold, threshold_unit: unit, required_facts: facts,
    evaluation_expression: expr, applicable_skill_ids: skills, applicable_agent_ids: ["*"],
    workspace_scope: "demo-uncle-coffee-wellness", environment_scope: "sandbox", severity, enforcement_action: enforcement,
    rule_version: 1, effective_from: now, effective_until: null, approved_by: "owner-bootstrap",
    approval_reference: "sandbox-default", modification_permissions: ["owner"], test_case_ids: [], enabled_status: true,
    audit_history: [{ at: now, by: "owner-bootstrap", change: "initial sandbox seed" }],
  });
  return [
    base("GR-FIN-001", "Max single purchase order", "financial", "numerical", "<=", 650000, "SGD cents", "CRITICAL", "DENY", ["total_cost_cents"], "total_cost_cents <= 650000", ["decision.prepare_purchase_order"], "A single PO must not exceed SGD 6,500."),
    base("GR-FIN-002", "Max daily procurement", "financial", "numerical", "<=", 1000000, "SGD cents", "CRITICAL", "DENY", ["daily_procurement_cents"], "daily_procurement_cents <= 1000000", ["decision.prepare_purchase_order"], "Daily procurement cap SGD 10,000."),
    base("GR-FIN-003", "Max monthly procurement", "financial", "numerical", "<=", 3000000, "SGD cents", "CRITICAL", "DENY", ["monthly_procurement_cents"], "monthly_procurement_cents <= 3000000", ["decision.prepare_purchase_order"], "Monthly procurement cap SGD 30,000."),
    base("GR-FIN-004", "Min contribution margin", "financial", "numerical", ">=", 30, "percent", "CRITICAL", "DENY", ["contribution_margin_percent"], "contribution_margin_percent >= 30", ["decision.calculate_discount"], "Discounts must keep >=30% contribution margin."),
    base("GR-FIN-005", "Max standard discount", "financial", "numerical", "<=", 15, "percent", "HIGH", "REQUIRE_APPROVAL", ["discount_percent"], "discount_percent <= 15", ["decision.calculate_discount"], "Standard discount cap 15%."),
    base("GR-FIN-006", "Max clearance discount (owner auth)", "financial", "numerical", "<=", 30, "percent", "HIGH", "REQUIRE_APPROVAL", ["discount_percent", "owner_authorized"], "discount_percent <= 30 AND owner_authorized", ["decision.calculate_discount"], "Clearance discount cap 30%, owner authorization required."),
    base("GR-FIN-007", "Max marketing campaign cost", "financial", "numerical", "<=", 10000, "SGD cents", "HIGH", "DENY", ["campaign_cost_cents"], "campaign_cost_cents <= 10000", ["marketing.create_campaign"], "Marketing campaign cost cap SGD 100."),
    base("GR-FIN-008", "Rounding discrepancy tolerance", "financial", "numerical", "==", 0, "SGD cents", "CRITICAL", "DENY", ["rounding_discrepancy_cents"], "rounding_discrepancy_cents == 0", ["decision.verify_mathematics"], "No rounding discrepancy after approved rounding."),
    base("GR-FIN-009", "Protected payment/store destinations", "financial", "allowlist", "in", [PAYPAL_PAYMENT_URL, HASHMETA_STORE_URL], "url", "CRITICAL", "DENY", ["outbound_url"], "outbound_url in approved destinations", ["store.publish", "decision.prepare_purchase_order"], "Only the owner-approved PayPal and storefront URLs may be used."),
    base("GR-FIN-010", "Duplicate financial transactions", "financial", "numerical", "==", 0, "count", "CRITICAL", "DENY", ["duplicate_count"], "duplicate_count == 0", ["automation.heal"], "Zero duplicate financial transactions."),
    base("GR-INV-001", "Approved supplier allowlist", "inventory_procurement", "allowlist", "in", null, "supplier_id", "CRITICAL", "DENY", ["supplier_id", "approved_suppliers"], "supplier_id in approved_suppliers", ["decision.prepare_purchase_order"], "Only workbook-approved suppliers."),
    base("GR-INV-002", "Positive integer quantity", "inventory_procurement", "numerical", ">", 0, "units", "CRITICAL", "DENY", ["quantity"], "quantity > 0 and integer", ["decision.calculate_reorder_quantity"], "Quantities must be positive integers."),
    base("GR-INV-003", "Product must exist", "inventory_procurement", "boolean", "==", true, "bool", "CRITICAL", "DENY", ["product_exists"], "product_exists == true", ["decision.prepare_purchase_order"], "Product must exist in the approved catalog."),
    base("GR-CUS-001", "Marketing consent required", "customer_marketing", "boolean", "==", true, "bool", "CRITICAL", "DENY", ["all_recipients_consented"], "all_recipients_consented == true", ["decision.prepare_customer_emails"], "No promotional contact without verified consent."),
    base("GR-CUS-002", "Max contacts per campaign", "customer_marketing", "numerical", "<=", 50, "recipients", "HIGH", "REQUIRE_APPROVAL", ["recipient_count"], "recipient_count <= 50", ["decision.generate_customer_contact_list"], "Bulk contact limited to 50 without extra approval."),
    base("GR-AGT-001", "Quarantined agent denied", "agent_execution", "boolean", "==", false, "bool", "CRITICAL", "CONTAIN", ["agent_quarantined"], "agent_quarantined == false", ["*"], "Quarantined agents cannot execute."),
    base("GR-AGT-002", "Gateway bypass denied", "agent_execution", "boolean", "==", false, "bool", "CRITICAL", "CONTAIN", ["bypass_attempt"], "bypass_attempt == false", ["*"], "Direct protected-resource access outside the gateway is denied."),
    base("GR-HEAL-001", "Bounded recovery retries", "automation_healing", "numerical", "<=", 2, "attempts", "HIGH", "ESCALATE", ["attempt_count"], "attempt_count <= 2", ["automation.heal"], "At most 2 recovery attempts, then escalate."),
    base("GR-HEAL-002", "Prohibited action replay denied", "automation_healing", "boolean", "==", false, "bool", "CRITICAL", "DENY", ["replay_of_prohibited"], "replay_of_prohibited == false", ["automation.heal"], "Never replay a prohibited action during recovery."),
  ];
}
function loadRules() {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(RULES)) { const r = seedRules(); writeFileSync(RULES, JSON.stringify(r, null, 2), { mode: 0o600 }); return r; }
  return JSON.parse(readFileSync(RULES, "utf8"));
}
function saveRules(rules) { mkdirSync(dir, { recursive: true }); const tmp = RULES + "." + randomUUID() + ".tmp"; writeFileSync(tmp, JSON.stringify(rules, null, 2), { mode: 0o600 }); renameSync(tmp, RULES); }
function appendEval(rec) { mkdirSync(dir, { recursive: true }); const line = JSON.stringify(rec) + "\n"; writeFileSync(EVALS, existsSync(EVALS) ? readFileSync(EVALS, "utf8") + line : line, { mode: 0o600 }); }
export function listRules() { return loadRules(); }
export function evaluationLog(limit = 50) { if (!existsSync(EVALS)) return []; return readFileSync(EVALS, "utf8").trim().split("\n").slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }

/* §9 Guardrail Control Centre: propose -> approve -> versioned persist -> rollback. Agents denied. */
export function proposeRuleChange(actor, rule_id, patch, rationale) {
  if (actor?.role !== "owner" && actor?.role !== "policy_admin") throw Object.assign(new Error("Only owner/policy_admin may propose guardrail changes"), { status: 403 });
  const rules = loadRules(); const rule = rules.find(r => r.rule_id === rule_id);
  if (!rule) throw Object.assign(new Error("rule not found"), { status: 404 });
  const changes = existsSync(CHANGES) ? JSON.parse(readFileSync(CHANGES, "utf8")) : [];
  const ch = { change_id: "GRC-" + randomUUID().slice(0, 8), rule_id, previous: { threshold_value: rule.threshold_value, rule_version: rule.rule_version }, proposed: patch, rationale: rationale || "", status: "PENDING", proposed_by: actor.id || actor.role, at: new Date().toISOString() };
  changes.push(ch); writeFileSync(CHANGES, JSON.stringify(changes, null, 2), { mode: 0o600 });
  return ch;
}
export function approveRuleChange(actor, change_id) {
  if (actor?.role !== "owner") throw Object.assign(new Error("Only the owner may approve guardrail changes"), { status: 403 });
  const changes = existsSync(CHANGES) ? JSON.parse(readFileSync(CHANGES, "utf8")) : [];
  const ch = changes.find(c => c.change_id === change_id);
  if (!ch) throw Object.assign(new Error("change not found"), { status: 404 });
  if (ch.status !== "PENDING") throw Object.assign(new Error("change not pending"), { status: 409 });
  const rules = loadRules(); const rule = rules.find(r => r.rule_id === ch.rule_id);
  Object.assign(rule, ch.proposed);
  rule.rule_version += 1; rule.approved_by = actor.id || "owner"; rule.approval_reference = ch.change_id;
  rule.audit_history.push({ at: new Date().toISOString(), by: actor.id || "owner", change: `approved ${ch.change_id}: ${JSON.stringify(ch.previous)} -> ${JSON.stringify(ch.proposed)}` });
  saveRules(rules); ch.status = "APPROVED"; ch.approved_at = new Date().toISOString();
  writeFileSync(CHANGES, JSON.stringify(changes, null, 2), { mode: 0o600 });
  return { change: ch, rule_version: rule.rule_version };
}
export function rollbackRule(actor, rule_id, to_version) {
  if (actor?.role !== "owner") throw Object.assign(new Error("Only the owner may roll back guardrails"), { status: 403 });
  const rules = loadRules(); const rule = rules.find(r => r.rule_id === rule_id);
  const hist = rule.audit_history.find(h => h.version === to_version) || rule.audit_history[0];
  rule.rule_version += 1; rule.audit_history.push({ at: new Date().toISOString(), by: actor.id || "owner", change: `rollback to version ${to_version} (ref ${hist?.change || "initial"})` });
  saveRules(rules); return { rule_id, rolled_back_to: to_version, new_version: rule.rule_version };
}
export function listChanges() { return existsSync(CHANGES) ? JSON.parse(readFileSync(CHANGES, "utf8")) : []; }
export function simulateRule(rule_id, fixtures) {
  const rule = loadRules().find(r => r.rule_id === rule_id);
  if (!rule) throw Object.assign(new Error("rule not found"), { status: 404 });
  return evaluateFacts([rule], fixtures);
}

/* §4 deterministic numerical/boolean/allowlist evaluation over integer cents. */
function checkRule(rule, facts) {
  const missing = (rule.required_facts || []).filter(f => facts[f] === undefined || facts[f] === null);
  if (missing.length) return { rule_id: rule.rule_id, rule_version: rule.rule_version, result: "MISSING_FACT", missing, severity: rule.severity, enforcement: rule.enforcement_action };
  const op = rule.comparison_operator, th = rule.threshold_value;
  let pass = true, observed = null;
  if (rule.rule_type === "numerical") {
    const f = rule.required_facts[0]; const val = facts[f];
    if (typeof val !== "number" || !Number.isFinite(val)) return { rule_id: rule.rule_id, rule_version: rule.rule_version, result: "INVALID_INPUT", severity: rule.severity, enforcement: rule.enforcement_action };
    observed = val;
    if (op === "<=") pass = val <= th; else if (op === "<") pass = val < th; else if (op === ">=") pass = val >= th; else if (op === ">") pass = val > th; else if (op === "==") pass = val === th; else if (op === "!=") pass = val !== th;
  } else if (rule.rule_type === "boolean") {
    const f = rule.required_facts[0]; const val = facts[f];
    if (typeof val !== "boolean") return { rule_id: rule.rule_id, rule_version: rule.rule_version, result: "INVALID_INPUT", severity: rule.severity, enforcement: rule.enforcement_action };
    observed = val; pass = op === "==" ? val === th : val !== th;
  } else if (rule.rule_type === "allowlist") {
    const f = rule.required_facts[0]; const val = facts[f];
    const list = Array.isArray(th) ? th : facts[rule.required_facts[1]];
    if (!Array.isArray(list)) return { rule_id: rule.rule_id, rule_version: rule.rule_version, result: "MISSING_FACT", missing: [rule.required_facts[1] || "allowlist"], severity: rule.severity, enforcement: rule.enforcement_action };
    observed = val; pass = list.includes(val);
  }
  return { rule_id: rule.rule_id, rule_version: rule.rule_version, result: pass ? "PASS" : "FAIL", observed, threshold: th, operator: op, severity: rule.severity, enforcement: rule.enforcement_action };
}
function evaluateFacts(rules, facts) {
  const evals = rules.filter(r => r.enabled_status).map(r => checkRule(r, facts));
  return evals;
}

/* §11 (spec1) centralized decision. factsFn supplies authoritative observed values.
 * Applicability: a rule is evaluated only when the request actually asserts its facts
 * (all present → evaluate; some present → missing-mandatory-evidence; none → not applicable).
 * request.mandatory_facts lists facts whose absence blocks outright. */
export function evaluateAction(request, facts, opts = {}) {
  const rules = loadRules();
  const mandatory = request.mandatory_facts || [];
  const missingMandatory = mandatory.filter(f => facts[f] === undefined || facts[f] === null);
  const applicable = rules.filter(r => {
    if (!r.enabled_status) return false;
    const present = (r.required_facts || []).filter(f => facts[f] !== undefined && facts[f] !== null);
    return present.length > 0;
  });
  const evals = evaluateFacts(applicable, facts);
  const failed = evals.filter(e => e.result === "FAIL");
  const missing = evals.filter(e => e.result === "MISSING_FACT" || e.result === "INVALID_INPUT")
    .concat(missingMandatory.map(f => ({ rule_id: "MANDATORY_FACT:" + f, result: "MISSING_FACT", missing: [f], severity: "CRITICAL", enforcement: "DENY" })));
  const contain = failed.find(e => e.enforcement === "CONTAIN");
  const deny = failed.find(e => e.enforcement === "DENY");
  const approval = failed.find(e => e.enforcement === "REQUIRE_APPROVAL");
  const escalate = failed.find(e => e.enforcement === "ESCALATE");
  let decision = "ALLOW";
  if (missing.length) decision = "BLOCKED_MISSING_EVIDENCE";
  else if (contain) decision = "QUARANTINE_REQUIRED";
  else if (deny) decision = "DENY";
  else if (approval && !opts.approval_present) decision = "REQUIRE_APPROVAL";
  else if (escalate) decision = "ESCALATE";
  else if (failed.length) decision = "REQUIRE_REVIEW";
  const rec = {
    decision_id: "TRD-" + randomUUID().slice(0, 8), agent_id: request.agent_id || null, skill_id: request.skill_id || null,
    objective_id: request.objective_id || null, request_hash: hash([request, facts]), timestamp: new Date().toISOString(),
    evaluated_rule_ids: evals.map(e => e.rule_id), rule_versions: Object.fromEntries(evals.map(e => [e.rule_id, e.rule_version])),
    verified_facts: facts, failed_constraints: failed.concat(missing), passed_constraints: evals.filter(e => e.result === "PASS").map(e => e.rule_id),
    decision, decision_reason: contain ? `CONTAIN: ${contain.rule_id}` : deny ? `DENY: ${deny.rule_id}` : missing.length ? `MISSING/INVALID: ${missing.map(m => m.rule_id).join(",")}` : approval ? `REQUIRE_APPROVAL: ${approval.rule_id}` : "all mandatory rules passed",
    authorization_scope: request.scope || "workspace", trust_version: TRUST_VERSION,
    llm_assessments: { execution_llm: opts.execution_llm || "not-consulted", supervising_llm: opts.supervising_llm || "not-consulted" },
    outcome: opts.outcome || "not-executed", incident_ref: opts.incident_ref || null,
  };
  appendEval(rec);
  return rec;
}

/* §13 autonomous remediation: reject + propose affordable quantity (never silently execute). */
export function remediateProcurement(request, facts, packSize) {
  const dec = evaluateAction({ ...request, mandatory_facts: request.mandatory_facts || ["total_cost_cents"] }, facts);
  if (dec.decision === "ALLOW") return { decision: dec, remediated: false };
  const budgetCents = facts.available_budget_cents; const unitCents = facts.unit_cost_cents;
  if (budgetCents == null || unitCents == null || !packSize) return { decision: dec, remediated: false, reason: "cannot compute affordable quantity without budget/unit-cost/pack-size" };
  const affordable = Math.floor(budgetCents / unitCents / packSize) * packSize;
  return { decision: dec, remediated: true, original_total_cents: facts.total_cost_cents, affordable_quantity: affordable > 0 ? affordable : null, note: "new proposal requires re-authorization; original not executed" };
}

/* §14 dual-LLM failure test: both LLMs approve a prohibited action; trust layer must still deny. */
export function dualLlmFailureTest() {
  const prohibited = { agent_id: "llm-exec", skill_id: "decision.prepare_purchase_order", category: "financial", description: "execution LLM proposes SGD 60,000 single PO" };
  const facts = { total_cost_cents: 6000000, quantity: 6000, product_exists: true, supplier_id: "DEMO-SUP-01", approved_suppliers: ["DEMO-SUP-01"], duplicate_count: 0, rounding_discrepancy_cents: 0 };
  const dec = evaluateAction({ ...prohibited, mandatory_facts: ["total_cost_cents", "quantity", "supplier_id", "product_exists"] }, facts, { execution_llm: "APPROVE (incorrect)", supervising_llm: "APPROVE (incorrect)" });
  const denied = dec.decision === "DENY" || dec.decision === "QUARANTINE_REQUIRED" || dec.decision === "BLOCKED_MISSING_EVIDENCE";
  return { both_llms_approved: true, trust_decision: dec.decision, denied_by: dec.failed_constraints.map(f => f.rule_id), blocked_despite_llm_approval: denied, side_effects: 0, evidence: dec };
}

/* Convenience wrappers used by protected actions. */
export function verifyProcurement({ quantity, unit_cost, currency, supplier_id, product_exists, approved_suppliers, committed_cents = 0, budget_cents, daily_cents = 0, monthly_cents = 0, duplicate_count = 0 }) {
  if (currency && currency !== "SGD") return evaluateAction({ category: "financial", skill_id: "decision.prepare_purchase_order" }, { total_cost_cents: null }, {});
  const total = quantity != null && unit_cost != null ? cents(unit_cost) * quantity : null;
  const facts = { total_cost_cents: total, daily_procurement_cents: daily_cents + (total || 0), monthly_procurement_cents: monthly_cents + (total || 0), quantity, product_exists: !!product_exists, supplier_id, approved_suppliers: approved_suppliers || [], duplicate_count, rounding_discrepancy_cents: 0, available_budget_cents: budget_cents, unit_cost_cents: unit_cost != null ? cents(unit_cost) : null, committed_cents };
  if (budget_cents != null && total != null && total + committed_cents > budget_cents) facts.budget_exceeded = true;
  return evaluateAction({ category: "financial", skill_id: "decision.prepare_purchase_order", mandatory_facts: ["total_cost_cents", "quantity", "supplier_id", "product_exists"] }, facts, {});
}
export function verifyDiscount({ percent, price, cost, owner_authorized = false }) {
  const margin = price != null && cost != null && price > 0 ? Math.round(((price * (1 - percent / 100) - cost) / (price * (1 - percent / 100))) * 1000) / 10 : null;
  const facts = { discount_percent: percent, contribution_margin_percent: margin, owner_authorized };
  return evaluateAction({ category: "financial", skill_id: "decision.calculate_discount", mandatory_facts: ["discount_percent", "contribution_margin_percent"] }, facts, { approval_present: owner_authorized });
}
export function verifyOutboundLink(url) {
  return evaluateAction({ category: "financial", skill_id: "store.publish", mandatory_facts: ["outbound_url"] }, { outbound_url: url }, {});
}
export function verifyCustomerContact({ recipient_count, all_recipients_consented }) {
  return evaluateAction({ category: "customer_marketing", skill_id: "decision.prepare_customer_emails", mandatory_facts: ["recipient_count", "all_recipients_consented"] }, { recipient_count, all_recipients_consented }, {});
}
export function trustStats() {
  const evals = evaluationLog(500);
  const rules = loadRules();
  return {
    trust_version: TRUST_VERSION,
    active_rules: rules.filter(r => r.enabled_status).length,
    rule_versions: Object.fromEntries(rules.map(r => [r.rule_id, r.rule_version])),
    evaluated: evals.length,
    allowed: evals.filter(e => e.decision === "ALLOW").length,
    denied: evals.filter(e => e.decision === "DENY").length,
    require_approval: evals.filter(e => e.decision === "REQUIRE_APPROVAL").length,
    missing_evidence: evals.filter(e => e.decision === "BLOCKED_MISSING_EVIDENCE").length,
    quarantine: evals.filter(e => e.decision === "QUARANTINE_REQUIRED").length,
    financial_violations_prevented: evals.filter(e => e.decision !== "ALLOW" && e.evaluated_rule_ids?.some(id => id.startsWith("GR-FIN"))).length,
    recent: evals.slice(-10).reverse(),
  };
}
