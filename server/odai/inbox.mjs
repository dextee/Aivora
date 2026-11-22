import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOffline } from "./db.mjs";

const root = fileURLToPath(new URL("../../odai/inbox/", import.meta.url));
export const categories = ["ALL", "APPROVALS", "SECURITY", "INSIGHTS", "UPDATES", "RECOVERY"];
const definitions = {
  OBJECTIVE_CREATED: ["UPDATES", "Objective accepted", "Your objective has been recorded. Review execution evidence for its current status."],
  OBJECTIVE_CREATED_REGISTRY: ["UPDATES", "Execution plan prepared", "A registered task plan is ready. Owner gates remain in force."],
  SHOP_PRODUCTS_ADDED: ["UPDATES", "Shop catalog updated", "Product associations were added to your shop."],
  SHOP_PRODUCT_UNLINKED: ["UPDATES", "Shop catalog updated", "A shop association was removed; the master product was preserved."],
  CAMPAIGN_CREATED: ["UPDATES", "Marketing copy prepared", "Catalog-based copy is ready. Media and publication are not implied."],
  PURCHASE_RECORDED: ["UPDATES", "Purchase recorded", "A purchase was recorded. This is not a claim of verified payment or revenue."],
  CUSTOMER_IMPORT: ["UPDATES", "Customer import processed", "The import was processed. Review validation results in the source module."],
  ROGUEAI_BLOCK: ["SECURITY", "Unauthorized export blocked", "The attempted export was blocked and the agent authorization revoked and quarantined. No replacement verification was recorded."],
  SECURITY_ALERT: ["SECURITY", "Security alert raised", "A prohibited action was detected and blocked by the RogueAI Shield. The affected agent authorization was revoked and quarantined."],
  PROCUREMENT_RECOMMENDED: ["INSIGHTS", "Automatic reorder recommended", "Business Intelligence detected a stockout risk and recommended a sandbox purchase order. Owner approval is required before any supplier action."],
  PURCHASE_ORDER_VERIFIED: ["UPDATES", "Purchase order verified", "The original authorized purchase order was re-verified intact in history after the security incident."],
  PRICE_MANIPULATION_BLOCKED: ["SECURITY", "Unauthorized price change blocked", "The price change was blocked and the agent quarantined. The approved price was preserved."],
  TASK_FAILED: ["RECOVERY", "Workflow needs attention", "The task failed after its bounded execution attempts. Recovery is not verified."],
  TASK_RETRY: ["RECOVERY", "Workflow retry recorded", "A bounded retry was attempted. This does not confirm recovery."],
  SELF_HEAL: ["RECOVERY", "Recovery verification recorded", "A purchase-save recovery check was recorded. Review the recorded verification result."],
  TASK_HELD: ["APPROVALS", "Task held for review", "Execution is held. Use the existing authorized review interface; this message is not authorization."],
  HASHMETA_PREPARE_PUBLICATION: ["APPROVALS", "Marketing publication held", "Publication preparation was recorded as held. Exact action binding is unavailable in this event; inbox approval is blocked."],
  FOLLOWUP_DRAFTED: ["UPDATES", "Customer follow-up drafted", "A follow-up draft is prepared. Nothing has been sent."],
  RUN_STARTED: ["UPDATES", "Sandbox workflow started", "The governed test workflow started. No completed work is implied."],
  BEAT_DONE: ["UPDATES", "Workflow step recorded", "A workflow step receipt was recorded. Review its actual decision."],
  APPOINTMENT_REGISTERED: ["UPDATES", "Appointment confirmed", "An owner-confirmed appointment was persisted. Calendar sync status is reported separately."],
  APPOINTMENT_REMINDER: ["UPDATES", "Appointment reminder", "A scheduled appointment reminder is due. Review the appointment record for details."],
  APPOINTMENT_ACCESS_DENIED: ["SECURITY", "Unauthorized appointment access blocked", "An appointment access or modification attempt was denied by tenant scope. No protected data was returned."],
};
export function inboxIntent(text) {
  if (/\b(inbox|latest messages|needs my approval|security problems|anything important today|brief me|what you have completed|what you are doing next)\b/i.test(text))
    return { category: /approval/i.test(text) ? "APPROVALS" : /security/i.test(text) ? "SECURITY" : "ALL" };
  return null;
}
function scope(tenant, user = "offline-owner") {
  if (!isOffline()) throw Object.assign(new Error("Online inbox blocked: validated auth membership and notification persistence schema are not integrated. No memory fallback."), { status: 503 });
  if (!tenant || user !== "offline-owner") throw Object.assign(new Error("Inbox scope denied"), { status: 403 });
  return { tenant, user };
}
function filename(s) { return root + createHash("sha256").update(JSON.stringify(s)).digest("hex") + ".json"; }
function load(s) {
  try { const data = JSON.parse(readFileSync(filename(s), "utf8")); if (!Array.isArray(data)) throw new Error("Invalid inbox store"); return data; }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function save(s, rows) {
  mkdirSync(root, { recursive: true });
  const dest = filename(s), tmp = dest + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 }); renameSync(tmp, dest);
}
export function ingestEvent(tenant, event, user = "offline-owner") {
  const s = scope(tenant, user);
  const kind = event.kind || event.event;
  const def = definitions[kind] || (["BLOCK", "NEVER"].includes(event.decision) && kind === "GATE" ? ["SECURITY", "Policy gate blocked", "A policy gate refused execution. No additional containment steps are implied."] : null);
  if (!def || !event.event_id || !event.ts) return null;
  const rows = load(s), key = `${tenant}/${user}/${event.event_id}`;
  const existing = rows.find((r) => r.deduplication_key === key);
  if (existing) return existing;
  // Never copy event notes, payloads, names, credentials or model prose into previews.
  const safeId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null;
  const actor = ["crm", "marketing", "orchestrator", "guardrails", "ai_commerce_agent", "human-gate", "hashmeta", "owner"].includes(event.actor) ? event.actor : "AI employee";
  const row = {
    notification_id: randomUUID(), workspace_id: tenant, user_id: user,
    objective_id: safeId(event.objective_id), task_id: safeId(event.task_id), agent_id: actor, skill_id: safeId(event.skill_id),
    event_id: event.event_id, notification_type: kind, category: def[0], severity: def[0] === "SECURITY" ? "critical" : def[0] === "RECOVERY" ? "warning" : "info",
    title: def[1], message: def[2], action_required: ["APPROVALS", "SECURITY", "RECOVERY"].includes(def[0]),
    action_type: "review_evidence", action_reference: null, evidence_references: [{ event_id: event.event_id, ts: event.ts, kind, decision: ["ALLOW", "HOLD", "BLOCK", "NEVER"].includes(event.decision) ? event.decision : null, beat: Number.isInteger(event.beat) ? event.beat : null }],
    read_status: "unread", approval_status: def[0] === "APPROVALS" ? "blocked_missing_exact_binding" : null,
    created_at: event.ts, read_at: null, resolved_at: null, archived_at: null,
    is_sandbox: event.mode === "TEST_SIMULATED" || kind === "RUN_STARTED" || event.is_sandbox === true,
    provenance: "Recorded execution event; business-data validation/sandbox provenance may be unavailable", deduplication_key: key,
    deep_link: /^SHOP_|PRICE_MANIPULATION/.test(kind) ? "myshop" : def[0] === "SECURITY" ? "security" : ["orchestrator", "human-gate"].includes(actor) ? "management" : null,
  };
  rows.push(row); save(s, rows); return row;
}
export function listInbox(tenant, filters = {}, user = "offline-owner") {
  const s = scope(tenant, user), all = load(s).filter((r) => !r.archived_at);
  const counts = { unread: all.filter((r) => r.read_status === "unread").length, approvals: all.filter((r) => r.category === "APPROVALS" && !r.resolved_at).length, security: all.filter((r) => r.category === "SECURITY" && !r.resolved_at).length, insights: all.filter((r) => r.category === "INSIGHTS").length };
  const rank = (r) => r.category === "SECURITY" && !r.resolved_at ? 0 : r.category === "APPROVALS" ? 1 : r.category === "RECOVERY" && !r.resolved_at ? 3 : r.category === "INSIGHTS" ? 4 : 6;
  const priority = [...all].sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
  const messages = [...all].filter((r) => (!filters.category || filters.category === "ALL" || r.category === filters.category) && (!filters.agent || r.agent_id === filters.agent) && (!filters.objective || r.objective_id === filters.objective) && (!filters.severity || r.severity === filters.severity) && (!filters.read || r.read_status === filters.read) && (!filters.date || r.created_at.slice(0, 10) === filters.date) && (!filters.q || `${r.title} ${r.message}`.toLowerCase().includes(String(filters.q).toLowerCase()))).sort((a,b) => b.created_at.localeCompare(a.created_at));
  return { source: "local_disk", mode: "explicit_offline", counts, messages, summary: priority.slice(0, 5).map((r) => r.title + ". " + r.message).join(" ") || "No stored messages yet.", voice_playback: "blocked_not_integrated" };
}
export function updateInbox(tenant, id, action, user = "offline-owner") {
  const s = scope(tenant, user), rows = load(s);
  if (!["read", "archive", "read_all"].includes(action)) throw Object.assign(new Error("Approval blocked: exact action/parameters/version binding and authorized handler integration required"), { status: 409 });
  const selected = action === "read_all" ? rows.filter((r) => !r.archived_at) : rows.filter((r) => r.notification_id === id);
  if (!selected.length && action !== "read_all") throw Object.assign(new Error("Notification not found"), { status: 404 });
  for (const r of selected) { if (action === "archive") r.archived_at = new Date().toISOString(); else { r.read_status = "read"; r.read_at ||= new Date().toISOString(); } }
  save(s, rows); return listInbox(tenant, {}, user);
}
