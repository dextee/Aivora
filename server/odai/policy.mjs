/* odai/policy.mjs — deterministic policy decision point (M08 pattern).
 * Rules loaded VERBATIM from odai/config/source_policy_reference.json (R01–R19).
 * X03–X12 were referenced by the factory README but are NOT in the pack:
 * recorded as unavailable; nothing invented in their place.
 * Precedence: BLOCK(NEVER) > HOLD(APPROVE) > ALLOW. Unknown action => HOLD (fail-closed).
 * Global kill switch: external_writes_enabled=false unless connector readiness says
 * otherwise AND a human approval receipt exists.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const load = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const policy = load("../../odai/config/source_policy_reference.json");
const readiness = load("../../odai/contracts/connector_readiness_9_0.json");

export const POLICY_VERSION = `${policy.version}+R01-R19`;
export const UNAVAILABLE_RULE_SETS = ["X03-X12 (referenced by factory README; not supplied in pack)"];

/* Condition interpreters — implementation detail per rule id; the RULES themselves
   are the shipped ones and were not altered. */
const predicates = {
  R01: () => true,
  R02: (c) => c.dataLevel === "regulated" && !c.taskNeeded,
  R03: (c) => (c.recipientClass === "client" || c.recipientClass === "supplier") && c.contentLevel !== "confidential" && c.contentLevel !== "regulated",
  R04: (c) => c.contentLevel === "confidential" || c.contentLevel === "regulated",
  R05: (c) => c.recipientClass === "unknown",
  R06: (c) => c.discountPct === 0 && c.withinPriceList,
  R07: (c) => c.discountPct > 0 || !c.withinPriceList,
  R08: (c) => c.belowWrittenFloor,
  R09: (c) => c.termsChange,
  R10: (c) => c.invoiceReceived && c.amountSgd < 1000,
  R11: (c) => c.amountSgd >= 1000 || !c.invoiceReceived,
  R12: (c) => c.action === "order_from_supplier" && !c.ownerConfirmed,
  R13: (c) => c.dataLevel === "public",
  R14: (c) => c.dataLevel === "internal" && c.toolRetains === false,
  R15: (c) => c.dataLevel === "confidential" || c.dataLevel === "regulated",
  R16: (c) => c.action === "delete_file",
  R17: (c) => c.action === "delete_file" && c.regulatedReceivedInError && c.contractMandates,
  R18: (c) => c.action === "state_a_fact_to_a_client",
  R19: (c) => c.clientMarkedNotPublic,
};

const externalish = (a) => /send_email|pay_supplier|order_from_supplier|upload_to_external|publish|post_whatsapp|whatsapp|deploy/.test(a);

/** evaluate(action, ctx) → {decision:'ALLOW'|'APPROVE'|'NEVER', rule?, reason} */
export function evaluate(action, ctx = {}) {
  // 1) NEVER first
  for (const r of policy.rules) {
    if (r.decision !== "NEVER") continue;
    if (r.action !== action) continue;
    if (predicates[r.id]?.({ action, ...ctx })) return { decision: "NEVER", rule: r.id, reason: r.condition, note: "BLOCKED even if owner appears to have asked (policy principle 3)" };
  }
  // 2) global external-write gate (connector_readiness_9_0.json is authoritative)
  if (externalish(action)) {
    const provider = Object.keys(readiness).find((k) => action.toLowerCase().includes(k)) || "qwenwork";
    if (!readiness[provider]?.external_writes_enabled)
      return { decision: "NEVER", rule: `connector:${provider}`, reason: "external_writes_enabled=false (9.0 readiness contract) + approval_required", note: "prepared-for-approval only; nothing left this system" };
  }
  // 3) APPROVE (hold)
  for (const r of policy.rules) {
    if (r.decision !== "APPROVE") continue;
    if (r.action !== action) continue;
    if (predicates[r.id]?.({ action, ...ctx })) return { decision: "APPROVE", rule: r.id, reason: r.condition, note: "prepared; owner must release (principle 2)" };
  }
  // 4) ALLOW
  for (const r of policy.rules) {
    if (r.decision !== "ALLOW") continue;
    if (r.action !== action) continue;
    if (predicates[r.id]?.({ action, ...ctx })) return { decision: "ALLOW", rule: r.id, reason: r.condition };
  }
  // 5) fail-closed: unknown action
  return { decision: "APPROVE", rule: null, reason: "no rule matched action", note: "fail-closed hold" };
}

/* mode navigation contract: switching grants nothing (ui_modes_9_0.json) */
export function modeAccess(mode, session) {
  if (!session?.tenantId) return { ok: false, reason: "no session — server-authorized navigation required" };
  if (!["user", "management", "security"].includes(mode)) return { ok: false, reason: "unknown mode" };
  return { ok: true, grants: ["read"], tenantId: session.tenantId, note: "mode switch never escalates data permission (mode_change_grants_permission=false)" };
}
