/* AIVORA V43 — Leads / enquiry CRM vertical slice (P0 storyboard: "attract customers, follow up with leads").
 * Reuses the existing tenant store + logEvent (store.mjs) and the existing customer-comms approval gate semantics.
 * HONESTY: follow-ups are produced as REVIEWABLE DRAFTS only. Outbound messaging (WhatsApp/email) stays
 * NEVER in this build (9.0 connector readiness / approve_customer_comms gate) — nothing is sent. No customer
 * PII beyond the captured enquiry; no invented prices/claims. */
import { get, logEvent } from "./store.mjs";

const leads = new Map();   // tenant -> [lead]
const dedup = new Map();   // `${tenant}/${requestId}` -> result

const uid = (p) => p + "-" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

function emit(tenant, kind, note, decision = "ALLOW") {
  try { logEvent(get(tenant), { runId: null, beat: "·", actor: "crm_agent", kind, decision, note }); } catch { /* trace unavailable */ }
}

export function listLeads(tenant) {
  const rows = leads.get(tenant) || [];
  return { tenant_id: tenant, leads: rows.map((l) => ({ ...l })), data_mode: "TEST", note: "local synthetic lead store; outbound comms NEVER (drafts only)" };
}

export function addLead(tenant, msg = {}) {
  const rid = msg.request_id != null ? String(msg.request_id).slice(0, 200) : null;
  const key = rid ? `${tenant}/${rid}` : null;
  if (key && dedup.has(key)) return { ...dedup.get(key), deduped: true };
  const message = String(msg.message || "").slice(0, 500).trim();
  if (!message) return { error: "message required" };
  const lead = {
    id: uid("LEAD"),
    tenant_id: tenant,
    name: String(msg.name || "Customer").slice(0, 80),
    channel: String(msg.channel || "whatsapp").slice(0, 40),
    message,
    captured_at: new Date().toISOString(),
    status: "new",
    followup_draft: null,
    comms: "HELD_NEVER_SENT",
  };
  if (!leads.has(tenant)) leads.set(tenant, []);
  leads.get(tenant).push(lead);
  emit(tenant, "LEAD_CAPTURED", `lead=${lead.id} channel=${lead.channel} status=new`);
  const out = { ...lead };
  if (key) dedup.set(key, out);
  return out;
}

/* Draft only. Grounded in the captured enquiry; no invented prices/claims; never sends. */
export function draftFollowup(tenant, leadId) {
  const rows = leads.get(tenant) || [];
  const lead = rows.find((l) => l.id === leadId);
  if (!lead) return { error: "lead not found for tenant" }; // tenant isolation
  const draft = `Hi ${lead.name}, thanks for reaching out about "${lead.message.slice(0, 80)}". I can help with that — could you share how many you need and when? ` +
    `(AIVORA draft · prices/details come from your approved catalog; nothing is sent until you approve.)`;
  lead.followup_draft = draft;
  lead.status = "followup_drafted";
  lead.comms = "HELD_NEVER_SENT";
  emit(tenant, "FOLLOWUP_DRAFTED", `lead=${lead.id} draft ready; sending requires owner approval`);
  emit(tenant, "COMMS_HELD", `lead=${lead.id} approve_customer_comms gate; external_effects=NEVER_ATTEMPTED`, "NEVER");
  return { ...lead, requires_approval: "approve_customer_comms", sent: false, external_effects: "NEVER_ATTEMPTED" };
}

export function resetLeads(tenant) { leads.set(tenant, []); return { ok: true }; }
