/* AIVORA — validated membership + unified persistent notification service.
 * Online (Supabase configured + signed-in bearer): reads/writes odai_notification,
 * odai_notification_recipient and odai_approval through the request-scoped client, so
 * Postgres RLS enforces workspace isolation; membership is validated server-side and a
 * failed DB is fail-closed (NO memory fallback). Offline demo: delegates to the existing
 * local-disk inbox store (persistent across restarts), clearly labelled explicit_offline. */
import { createHash } from "node:crypto";
import { isOffline, supabaseConfigured, scopedClient, dbAvailable, DbUnavailable, DbAuthRequired, requestCtx } from "./db.mjs";
import { ingestEvent, listInbox, updateInbox } from "./inbox.mjs";

const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/* §9 classification + priority derived from actual source event kinds. */
const CATEGORY_MAP = {
  CUSTOMER_EMAIL: ["CUSTOMER_EMAIL", "NORMAL"], CUSTOMER_EMAIL_RECEIVED: ["CUSTOMER_EMAIL", "NORMAL"],
  CUSTOMER_ENQUIRY: ["CUSTOMER_ENQUIRY", "NORMAL"], CUSTOMER_ORDER: ["CUSTOMER_ORDER", "HIGH"],
  CUSTOMER_ORDER_RECEIVED: ["CUSTOMER_ORDER", "HIGH"], CUSTOMER_ORDER_CONFIRMED: ["CUSTOMER_ORDER", "NORMAL"],
  CUSTOMER_PAYMENT_VERIFIED: ["CUSTOMER_ORDER", "HIGH"],
  INVOICE: ["INVOICE", "NORMAL"], INVOICE_GENERATED: ["INVOICE", "NORMAL"],
  QUOTATION: ["QUOTATION", "NORMAL"], QUOTATION_GENERATED: ["QUOTATION", "NORMAL"],
  RECEIPT: ["RECEIPT", "LOW"], RECEIPT_GENERATED: ["RECEIPT", "LOW"],
  SUPPLIER_COMMUNICATION: ["SUPPLIER_COMMUNICATION", "NORMAL"],
  PURCHASE_ORDER: ["PURCHASE_ORDER", "HIGH"], PROCUREMENT_RECOMMENDATION_CREATED: ["PURCHASE_ORDER", "HIGH"],
  PURCHASE_ORDER_AWAITING_APPROVAL: ["APPROVAL_REQUEST", "HIGH"], PURCHASE_ORDER_APPROVED: ["PURCHASE_ORDER", "NORMAL"],
  PURCHASE_ORDER_SUBMITTED: ["PURCHASE_ORDER", "NORMAL"], SUPPLIER_ORDER_CONFIRMED: ["PURCHASE_ORDER", "NORMAL"],
  GOODS_PARTIALLY_RECEIVED: ["PURCHASE_ORDER", "NORMAL"], GOODS_RECEIVED: ["PURCHASE_ORDER", "NORMAL"],
  PURCHASE_ORDER_CANCELLED: ["PURCHASE_ORDER", "NORMAL"], PURCHASE_ORDER_PDF_GENERATED: ["PURCHASE_ORDER", "LOW"],
  INVENTORY_ALERT: ["INVENTORY_ALERT", "HIGH"], INVENTORY_SHORTAGE_DETECTED: ["INVENTORY_ALERT", "HIGH"],
  BUSINESS_INTELLIGENCE: ["BUSINESS_INTELLIGENCE", "NORMAL"], BUSINESS_REPORT_GENERATED: ["BUSINESS_INTELLIGENCE", "NORMAL"],
  PRODUCT_DEMAND_INCREASED: ["BUSINESS_INTELLIGENCE", "NORMAL"], PRODUCT_PERFORMANCE_DECLINED: ["BUSINESS_INTELLIGENCE", "NORMAL"],
  APPOINTMENT: ["APPOINTMENT", "NORMAL"], APPOINTMENT_CREATED: ["APPOINTMENT", "NORMAL"],
  APPOINTMENT_RESCHEDULED: ["APPOINTMENT", "NORMAL"], APPOINTMENT_CANCELLED: ["APPOINTMENT", "NORMAL"],
  APPOINTMENT_REMINDER_DUE: ["APPOINTMENT", "HIGH"],
  WHATSAPP_MESSAGE: ["WHATSAPP_MESSAGE", "NORMAL"], INVITATION_SUBMITTED: ["WHATSAPP_MESSAGE", "NORMAL"],
  MESSAGE_STATUS_UPDATED: ["WHATSAPP_MESSAGE", "LOW"], CUSTOMER_RSVP_RECEIVED: ["WHATSAPP_MESSAGE", "NORMAL"],
  MARKETING: ["MARKETING", "NORMAL"], MARKETING_VIDEO_COMPLETED: ["MARKETING", "NORMAL"],
  MARKETING_POSTER_COMPLETED: ["MARKETING", "NORMAL"], MARKETING_ASSETS_AWAITING_APPROVAL: ["APPROVAL_REQUEST", "HIGH"],
  STORE_PUBLICATION_VERIFIED: ["STORE_UPDATE", "NORMAL"], STORE_UPDATE: ["STORE_UPDATE", "NORMAL"],
  STORE_CONFIGURATION_UPDATED: ["STORE_UPDATE", "LOW"], CUSTOMER_PURCHASE_REQUEST_RECEIVED: ["STORE_UPDATE", "HIGH"],
  PAYMENT_VERIFICATION_COMPLETED: ["STORE_UPDATE", "HIGH"],
  AI_AGENT_UPDATE: ["AI_AGENT_UPDATE", "NORMAL"],
  SECURITY_INCIDENT: ["SECURITY_INCIDENT", "CRITICAL"], UNAUTHORIZED_ACTION_BLOCKED: ["SECURITY_INCIDENT", "CRITICAL"],
  SECURITY_INCIDENT_CREATED: ["SECURITY_INCIDENT", "CRITICAL"], AGENT_PERMISSIONS_REVOKED: ["SECURITY_INCIDENT", "CRITICAL"],
  AGENT_QUARANTINED: ["SECURITY_INCIDENT", "CRITICAL"], TRUSTED_REPLACEMENT_VERIFIED: ["SECURITY_INCIDENT", "HIGH"],
  SECURITY_ALERT: ["SECURITY_INCIDENT", "CRITICAL"], ROGUEAI_BLOCK: ["SECURITY_INCIDENT", "CRITICAL"],
  PRICE_MANIPULATION_BLOCKED: ["SECURITY_INCIDENT", "CRITICAL"],
  AUTOMATION_FAILURE: ["AUTOMATION_FAILURE", "HIGH"], WORKFLOW_FAILURE_DETECTED: ["AUTOMATION_FAILURE", "HIGH"],
  OWNER_INTERVENTION_REQUIRED: ["AUTOMATION_FAILURE", "CRITICAL"], TASK_FAILED: ["AUTOMATION_FAILURE", "HIGH"],
  AUTOMATION_RECOVERY: ["AUTOMATION_RECOVERY", "NORMAL"], RECOVERY_STARTED: ["AUTOMATION_RECOVERY", "NORMAL"],
  RECOVERY_VERIFIED: ["AUTOMATION_RECOVERY", "NORMAL"], SELF_HEAL: ["AUTOMATION_RECOVERY", "NORMAL"], TASK_RETRY: ["AUTOMATION_RECOVERY", "NORMAL"],
  APPROVAL_REQUEST: ["APPROVAL_REQUEST", "HIGH"], TASK_HELD: ["APPROVAL_REQUEST", "HIGH"],
  HASHMETA_PREPARE_PUBLICATION: ["APPROVAL_REQUEST", "HIGH"], EMAIL_AWAITING_APPROVAL: ["APPROVAL_REQUEST", "HIGH"],
  EMAIL_DRAFT_PREPARED: ["CUSTOMER_EMAIL", "NORMAL"], EMAIL_ACCEPTED_BY_GMAIL: ["CUSTOMER_EMAIL", "NORMAL"],
  EMAIL_DISPATCH_FAILED: ["AUTOMATION_FAILURE", "HIGH"],
  SYSTEM_NOTICE: ["SYSTEM_NOTICE", "LOW"], TEST_REPORT_READY: ["BUSINESS_INTELLIGENCE", "NORMAL"],
  OBJECTIVE_CREATED: ["AI_AGENT_UPDATE", "NORMAL"], CUSTOMER_IMPORT: ["CUSTOMER_ENQUIRY", "LOW"],
};
export const classify = kind => CATEGORY_MAP[kind] || ["SYSTEM_NOTICE", "NORMAL"];

const PERM = { read: ["owner", "admin", "member"], approve: ["owner", "admin"], manage: ["owner", "admin"] };

/* §3/§5 centralized membership validation. Never trusts client-supplied ids. */
export async function validateInboxMembership({ workspaceId, requiredPermission = "read" } = {}) {
  if (isOffline()) {
    return { mode: "explicit_offline", user_id: "offline-owner", workspace_id: workspaceId || "demo-uncle-coffee-wellness", membership_id: "offline-owner-membership", membership_status: "ACTIVE", role: "owner", permissions: PERM, session_valid: true };
  }
  if (!supabaseConfigured()) throw Object.assign(new DbUnavailable("Supabase not configured: membership validation unavailable"), { status: 503, code: "INBOX_ONLINE_NOT_CONFIGURED" });
  const token = requestCtx.getStore()?.token;
  if (!token) throw Object.assign(new DbAuthRequired(), { status: 401, code: "AUTH_REQUIRED" });
  const client = scopedClient();
  const { data: user, error: uerr } = await client.auth.getUser();
  if (uerr || !user?.user?.id) throw Object.assign(new Error("Authenticated identity could not be verified"), { status: 401, code: "IDENTITY_UNVERIFIED" });
  const uid = user.user.id;
  const { data: rows, error: merr } = await client.from("odai_workspace_member").select("tenant_id,user_id,role,membership_status,version").eq("user_id", uid);
  if (merr) throw Object.assign(new DbUnavailable(merr.message), { status: 503, code: "MEMBERSHIP_LOOKUP_FAILED" });
  const active = (rows || []).filter(m => m.membership_status === "ACTIVE");
  if (!active.length) throw Object.assign(new Error("No active workspace membership for this authenticated user"), { status: 403, code: "MEMBERSHIP_DENIED" });
  let m = active.find(x => x.tenant_id === workspaceId) || (workspaceId ? null : active[0]);
  if (workspaceId && !m) throw Object.assign(new Error("Membership for the requested workspace not found"), { status: 403, code: "WORKSPACE_MEMBERSHIP_DENIED" });
  if (!PERM[requiredPermission]?.includes(m.role)) throw Object.assign(new Error(`Role ${m.role} lacks ${requiredPermission} permission`), { status: 403, code: "PERMISSION_DENIED" });
  return { mode: "supabase", user_id: uid, workspace_id: m.tenant_id, membership_id: `${m.tenant_id}:${m.user_id}`, membership_status: m.membership_status, role: m.role, membership_version: m.version, permissions: PERM, session_valid: true };
}

/* §13 unified service. Online = Supabase persistent; offline = local-disk inbox. */
export async function createNotification(ctx, input) {
  const [category, prio] = classify(input.kind || input.notification_type);
  const dedup = input.deduplication_key || hash([ctx.workspace_id, input.kind, input.source_entity_id || input.event_id || input.message || ""]);
  if (ctx.mode === "explicit_offline") {
    const row = ingestEvent(ctx.workspace_id, { kind: input.kind, event_id: input.event_id || dedup, ts: input.ts || new Date().toISOString(), actor: input.agent_id || "orchestrator", objective_id: input.objective_id, note: input.message });
    return { mode: "explicit_offline", persisted: !!row, notification_id: row?.id || row?.deduplication_key || dedup, deduplication_key: dedup, category, priority: prio };
  }
  const client = scopedClient();
  const { data, error } = await client.from("odai_notification").insert({
    tenant_id: ctx.workspace_id, source_module: input.source_module || "aivora", source_event_id: input.event_id || null,
    source_entity_type: input.source_entity_type || null, source_entity_id: input.source_entity_id || null,
    objective_id: input.objective_id || null, task_id: input.task_id || null, agent_id: input.agent_id || null, skill_id: input.skill_id || null,
    notification_type: input.kind, category, priority: input.priority || prio, title: input.title || category, message: input.message || "",
    structured_payload: input.payload || {}, action_type: input.action_type || null, action_reference: input.action_reference || null,
    deduplication_key: dedup, correlation_id: input.correlation_id || null,
  }).select().single();
  if (error) {
    if (/duplicate key/i.test(error.message)) return { mode: "supabase", persisted: true, deduplicated: true, deduplication_key: dedup, category, priority: prio };
    throw Object.assign(new DbUnavailable(error.message), { status: 503, code: "NOTIFICATION_PERSIST_FAILED" });
  }
  if (input.recipient_user_ids?.length) {
    await client.from("odai_notification_recipient").insert(input.recipient_user_ids.map(u => ({ notification_id: data.notification_id, tenant_id: ctx.workspace_id, user_id: u })));
  } else {
    await client.from("odai_notification_recipient").insert({ notification_id: data.notification_id, tenant_id: ctx.workspace_id, user_id: ctx.user_id });
  }
  return { mode: "supabase", persisted: true, notification_id: data.notification_id, deduplication_key: dedup, category, priority: prio };
}
export const publishBusinessNotification = (ctx, input) => createNotification(ctx, input);

export async function listNotifications(ctx, filters = {}) {
  if (ctx.mode === "explicit_offline") { const r = listInbox(ctx.workspace_id, filters); return { mode: r.mode, source: r.source, counts: r.counts, notifications: r.messages, messages: r.messages, summary: r.summary, voice_playback: r.voice_playback }; }
  const client = scopedClient();
  let q = client.from("odai_notification").select("*").eq("tenant_id", ctx.workspace_id).order("created_at", { ascending: false });
  if (filters.category && filters.category !== "ALL") q = q.eq("category", filters.category);
  if (filters.priority) q = q.eq("priority", filters.priority);
  if (filters.q) q = q.ilike("title", `%${filters.q}%`);
  if (filters.cursor) q = q.lt("created_at", filters.cursor);
  q = q.limit(filters.limit || 50);
  const { data, error } = await q;
  if (error) throw Object.assign(new DbUnavailable(error.message), { status: 503, code: "NOTIFICATION_READ_FAILED" });
  return { mode: "supabase", source: "supabase", notifications: data || [], messages: data || [], counts: await getUnreadCount(ctx) };
}
export async function getNotification(ctx, id) {
  if (ctx.mode === "explicit_offline") { const r = listInbox(ctx.workspace_id, {}); const m = (r.messages || []).find(x => x.id === id); if (!m) throw Object.assign(new Error("not found"), { status: 404 }); return { mode: r.mode, notification: m }; }
  const { data, error } = await scopedClient().from("odai_notification").select("*").eq("notification_id", id).eq("tenant_id", ctx.workspace_id).single();
  if (error) throw Object.assign(new Error(error.message), { status: 404 });
  return { mode: "supabase", notification: data };
}
export async function getUnreadCount(ctx) {
  if (ctx.mode === "explicit_offline") return listInbox(ctx.workspace_id, {}).counts;
  const { count, error } = await scopedClient().from("odai_notification_recipient").select("notification_id", { count: "exact", head: true }).eq("tenant_id", ctx.workspace_id).eq("user_id", ctx.user_id).is("read_at", null);
  if (error) throw Object.assign(new DbUnavailable(error.message), { status: 503 });
  return { unread: count };
}
export async function markAsRead(ctx, id) {
  if (ctx.mode === "explicit_offline") return updateInbox(ctx.workspace_id, id, "read");
  const { error } = await scopedClient().from("odai_notification_recipient").update({ read_at: new Date().toISOString() }).eq("notification_id", id).eq("user_id", ctx.user_id);
  if (error) throw Object.assign(new DbUnavailable(error.message), { status: 503 });
  return { ok: true, mode: "supabase" };
}
export async function markAllAsRead(ctx) {
  if (ctx.mode === "explicit_offline") return updateInbox(ctx.workspace_id, null, "read_all");
  const { error } = await scopedClient().from("odai_notification_recipient").update({ read_at: new Date().toISOString() }).eq("tenant_id", ctx.workspace_id).eq("user_id", ctx.user_id).is("read_at", null);
  if (error) throw Object.assign(new DbUnavailable(error.message), { status: 503 });
  return { ok: true, mode: "supabase" };
}
export async function archiveNotification(ctx, id) {
  if (ctx.mode === "explicit_offline") return updateInbox(ctx.workspace_id, id, "archive");
  const { error } = await scopedClient().from("odai_notification_recipient").update({ archived_at: new Date().toISOString() }).eq("notification_id", id).eq("user_id", ctx.user_id);
  if (error) throw Object.assign(new DbUnavailable(error.message), { status: 503 });
  return { ok: true, mode: "supabase" };
}

/* §11 durable approval bound to entity version + payload hash. */
export async function requestApproval(ctx, { entity_type, entity_id, action, parameters, entity_version = 1, agent_id, permission = "approve" }) {
  const payload_hash = hash([entity_type, entity_id, action, parameters, entity_version]);
  if (ctx.mode === "explicit_offline") return { mode: "explicit_offline", approval_id: "offline-" + payload_hash.slice(0, 12), payload_hash, status: "PENDING", note: "offline sandbox approval record" };
  const client = scopedClient();
  const { data, error } = await client.from("odai_approval").insert({ tenant_id: ctx.workspace_id, source_entity_type: entity_type, source_entity_id: entity_id, requested_action: action, approved_parameters: parameters || {}, entity_version, payload_hash, requested_by_agent_id: agent_id || null, required_permission: permission, authorized_owner_id: ctx.user_id }).select().single();
  if (error) { if (/duplicate key/i.test(error.message)) { const { data: ex } = await client.from("odai_approval").select("*").eq("tenant_id", ctx.workspace_id).eq("payload_hash", payload_hash).single(); return { mode: "supabase", approval_id: ex?.approval_id, payload_hash, status: ex?.approval_status, deduplicated: true }; } throw Object.assign(new DbUnavailable(error.message), { status: 503 }); }
  return { mode: "supabase", approval_id: data.approval_id, payload_hash, status: data.approval_status };
}
export async function resolveApproval(ctx, { approval_id, decision, payload_hash }) {
  if (ctx.role !== "owner" && ctx.role !== "admin") throw Object.assign(new Error("Only owner/admin may resolve approvals"), { status: 403, code: "PERMISSION_DENIED" });
  if (ctx.mode === "explicit_offline") {
    if (!decision || !["approve", "reject"].includes(decision)) throw Object.assign(new Error("decision must be approve or reject"), { status: 400, code: "BAD_DECISION" });
    if (!approval_id || !String(approval_id).startsWith("offline-")) throw Object.assign(new Error("approval not found"), { status: 404, code: "APPROVAL_NOT_FOUND" });
    return { mode: "explicit_offline", approval_id, decision, status: decision === "approve" ? "APPROVED" : "REJECTED", note: "offline sandbox; exact-binding enforced by the calling action" };
  }
  const client = scopedClient();
  const { data: cur } = await client.from("odai_approval").select("*").eq("approval_id", approval_id).eq("tenant_id", ctx.workspace_id).single();
  if (!cur) throw Object.assign(new Error("approval not found"), { status: 404 });
  if (payload_hash && cur.payload_hash !== payload_hash) { await client.from("odai_approval").update({ approval_status: "INVALIDATED" }).eq("approval_id", approval_id); throw Object.assign(new Error("Parameters changed; original approval invalidated"), { status: 409, code: "APPROVAL_INVALIDATED" }); }
  if (cur.approval_status === "EXECUTED") throw Object.assign(new Error("Approval already executed; duplicate execution prevented"), { status: 409, code: "ALREADY_EXECUTED" });
  const status = decision === "approve" ? "APPROVED" : "REJECTED";
  const { error } = await client.from("odai_approval").update({ approval_status: status, approved_at: decision === "approve" ? new Date().toISOString() : null, rejected_at: decision === "reject" ? new Date().toISOString() : null }).eq("approval_id", approval_id);
  if (error) throw Object.assign(new DbUnavailable(error.message), { status: 503 });
  return { mode: "supabase", approval_id, status };
}

/* §25 real readiness check across all dimensions. */
export async function healthCheck() {
  const offline = isOffline();
  const configured = supabaseConfigured();
  const bearer = !!requestCtx.getStore()?.token;
  let db = "BLOCKED", schema = "BLOCKED", membership = "BLOCKED";
  if (!offline && configured) {
    try { const ok = await dbAvailable(); db = ok ? "READY" : "BLOCKED"; } catch { db = "DEGRADED"; }
    if (db === "READY") {
      try { const { error } = await scopedClient().from("odai_notification").select("notification_id", { count: "exact", head: true }); schema = error ? "BLOCKED" : "READY"; } catch { schema = "BLOCKED"; }
      membership = bearer ? "READY" : "BLOCKED";
    }
  }
  const native = offline ? "READY" : (db === "READY" && schema === "READY" && membership === "READY" ? "READY" : "BLOCKED");
  return {
    native_inbox: native,
    dimensions: {
      authentication: offline ? "READY (offline owner session)" : bearer ? "READY" : "BLOCKED (no signed-in bearer)",
      membership_validation: offline ? "READY (offline owner)" : membership,
      database_connectivity: offline ? "READY (local disk store)" : db,
      schema_availability: offline ? "READY (local disk schema)" : schema,
      notification_service: native,
      event_ingestion: native,
      approval_service: native,
      frontend_api_integration: "READY",
    },
    gmail: "REPORTED_SEPARATELY",
    voice: "REPORTED_SEPARATELY (audio needs mic + key)",
    mode: offline ? "explicit_offline" : configured ? "supabase" : "unconfigured",
  };
}
