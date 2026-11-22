/* AIVORA voice→calendar→WhatsApp appointment workflow (additive; reuses the
 * existing appointment engine, Customer Contacts, My Inbox and RogueAI evidence).
 * Honesty rules:
 *  - WhatsApp dispatch only happens through the official Cloud API when server
 *    credentials exist, or through a CLEARLY LABELED sandbox (WHATSAPP_SANDBOX=1).
 *    Without either, invitations are generated and HELD — no external call.
 *  - A successful API submission is recorded as "submitted", never "delivered".
 *  - Recipients come only from authorized Customer Contacts with consent and a
 *    verified phone number; nothing is invented.
 *  - Owner approval is bound to an appointment fingerprint; any material change
 *    invalidates it and a fresh confirmation is required.
 */
import { randomUUID, createHash } from "node:crypto";
import { get, logEvent } from "./store.mjs";
import { searchCustomers } from "./customers.mjs";
import { ingestEvent } from "./inbox.mjs";
import {
  getAppointment, mutateAppointment, confirmAppointment, rescheduleAppointment,
  suggestAlternatives, calendarStatus, scheduleReminder, recordAppointmentSecurityIncident,
  listAppointments,
} from "./appointments.mjs";

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, thirty: 30, forty: 40, sixty: 60, ninety: 90 };
const pad = (n) => String(n).padStart(2, "0");
const digits = (s) => String(s || "").replace(/[^0-9]/g, "");

export function whatsappStatus() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || null;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
  const sandbox = process.env.WHATSAPP_SANDBOX === "1";
  const live = !!(token && phoneId);
  return {
    provider: "whatsapp_business_cloud_api",
    configured: live || sandbox,
    mode: live ? "live" : sandbox ? "sandbox" : "not_configured",
    business_account_id: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    sender_number_id: live ? phoneId : null,
    note: live
      ? "Server-side WhatsApp Business credentials present. Sends only after owner approval."
      : sandbox
        ? "Labeled sandbox adapter (WHATSAPP_SANDBOX=1). Message IDs are SANDBOX-*; nothing is sent to real recipients."
        : "Set WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID (server env only) for live sends, or WHATSAPP_SANDBOX=1 for a labeled test adapter. Invitations are generated and held until then.",
  };
}

export function connectionStatus() {
  return { calendar: calendarStatus(), whatsapp: whatsappStatus() };
}

/* ---- Target audience: authorized contacts only, consent + dedup ---- */
const GROUPS = [
  { re: /\bdistributors?\b|分销商|经销商/i, key: "distributor", label: "coffee distributors" },
  { re: /\bsuppliers?\b|供应商/i, key: "supplier", label: "suppliers" },
  { re: /\bvip( customers?)?\b/i, key: "vip", label: "VIP customers" },
  { re: /\bsales team\b/i, key: "sales team", label: "sales team" },
  { re: /\bmanagement team\b/i, key: "management", label: "management team" },
  { re: /\bbusiness partners?\b/i, key: "partner", label: "business partners" },
  { re: /\ball (my )?customers?\b|所有客户/i, key: "all", label: "all customers" },
];

function eligible(c) {
  const phone = digits(c.phone_number);
  if (!phone) return { ok: false, reason: "no verified mobile number" };
  if (!c.marketing_consent) return { ok: false, reason: "no WhatsApp/marketing consent on record" };
  return { ok: true, phone };
}
function toRecipient(c, phone) {
  return { customer_id: c.customer_id, name: c.customer_name, phone, language: c.preferred_language === "zh" ? "zh" : "en", consent: true, source: "authorized_customer_records" };
}

export function resolveAudience(tenant, text) {
  const t = String(text || "");
  const all = searchCustomers(tenant, { pageSize: 1000 }).customers || [];
  const picked = new Map();
  const excluded = [];
  let groupLabel = null;
  const group = GROUPS.find((g) => g.re.test(t));
  if (group) {
    groupLabel = group.label;
    const members = all.filter((c) => {
      if (group.key === "all") return true;
      if (group.key === "vip") return c.customer_category === "VIP";
      const hay = `${c.customer_notes || ""} ${c.customer_source || ""} ${c.customer_name || ""}`.toLowerCase();
      return hay.includes(group.key);
    });
    for (const c of members) {
      const e = eligible(c);
      if (!e.ok) { excluded.push({ customer_id: c.customer_id, name: c.customer_name, reason: e.reason }); continue; }
      if (![...picked.values()].some((r) => r.phone === e.phone)) picked.set(c.customer_id, toRecipient(c, e.phone));
    }
  }
  /* Named individuals: "add John and Peter", "invite John Smith" */
  const nm = t.match(/\b(?:add|invite|include|with)\s+([A-Z][\w'-]*(?:\s+(?:and|,)\s+[A-Z][\w'-]*)*)/);
  const names = nm ? nm[1].split(/\s+and\s+|,\s*/).map((s) => s.trim()).filter(Boolean) : [];
  const ambiguous = [];
  for (const name of names) {
    const hits = (searchCustomers(tenant, { q: name, pageSize: 5 }).customers || []);
    if (hits.length === 0) { excluded.push({ name, reason: "no authorized contact record found — not invented" }); continue; }
    if (hits.length > 1) { ambiguous.push({ name, candidates: hits.map((h) => ({ customer_id: h.customer_id, name: h.customer_name })) }); continue; }
    const c = hits[0]; const e = eligible(c);
    if (!e.ok) { excluded.push({ customer_id: c.customer_id, name: c.customer_name, reason: e.reason }); continue; }
    if (![...picked.values()].some((r) => r.phone === e.phone)) picked.set(c.customer_id, toRecipient(c, e.phone));
  }
  const recipients = [...picked.values()];
  return {
    group: groupLabel, recipients, count: recipients.length, excluded, ambiguous,
    question: ambiguous.length ? `Which ${ambiguous[0].name} do you mean? ${ambiguous[0].candidates.map((c) => c.name).join(", ")}`
      : group && recipients.length === 0 ? `No saved ${groupLabel} with consent and a verified number were found. Who should I invite?`
      : null,
    note: "Recipients resolved only from authorized Customer Contacts (consent + verified number, deduplicated).",
  };
}

/* ---- Voice corrections on the SAME appointment (no new objective) ---- */
export function correctAppointment(tenant, id, text) {
  const t = String(text || "");
  const { appointment: a0 } = getAppointment(tenant, id);
  const changed = [];
  let a = a0;

  /* time change: "change the meeting to four in the afternoon" / "to 4 pm" */
  const tm = t.match(/\bto\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    || t.match(/\bto\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:(in\s+the\s+)?(morning|afternoon|evening))?\b/i)
    || t.match(/\bto\s+(\d{1,2}):(\d{2})\b/);
  if (tm) {
    let h = WORD_NUM[String(tm[1]).toLowerCase()] ?? Number(tm[1]);
    const min = tm[2] && /^\d+$/.test(tm[2]) ? Number(tm[2]) : 0;
    const part = (tm[3] || tm[4] || "").toLowerCase();
    if (/pm|afternoon|evening/.test(part) && h < 12) h += 12;
    if (/am|morning/.test(part) && h === 12) h = 0;
    if (!part && h >= 1 && h <= 7) h += 12;
    const start = `${pad(h)}:${pad(min)}`;
    const r = rescheduleAppointment(tenant, id, { start }); /* preserves ID, rechecks conflicts, replaces reminder */
    a = r.appointment; changed.push(`start time → ${start}`);
  }
  /* duration: "make the meeting two hours" / "make it 90 minutes" */
  const dm = t.match(/\b(?:make (?:the meeting|the|it)|for)\s+(?:(\d+)|(one|two|three)|half an?)\s*(hours?|hrs?|minutes?|mins?)\b/i);
  if (dm) {
    const count = dm[1] ? Number(dm[1]) : dm[2] ? WORD_NUM[dm[2].toLowerCase()] : 0.5;
    const minutes = /min/i.test(dm[3]) ? Math.round(count) : Math.round(count * 60);
    if (minutes >= 5 && minutes <= 480) {
      const [h, m] = a.start.split(":").map(Number);
      const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
      mutateAppointment(tenant, id, (x) => { x.end = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`; });
      changed.push(`duration → ${minutes} minutes`);
    }
  }
  /* location: "change the location to my office" */
  const lm = t.match(/\b(?:change the location to|location(?: is|:)?|meet at)\s+([^.;!?]+?)[.!]?$/i);
  if (lm && /location|meet at/i.test(t)) {
    const loc = lm[1].trim();
    mutateAppointment(tenant, id, (x) => { x.location = loc; });
    changed.push(`location → ${loc}`);
  }
  /* reminder: "remind everyone thirty minutes before" */
  const rm = t.match(/\bremind\b.*?(\d+|thirty|sixty|fifteen|ten|twenty)\s*(minutes?|hours?)\s*before/i);
  if (rm) {
    const n = WORD_NUM[String(rm[1]).toLowerCase()] ?? Number(rm[1]);
    const mins = /hour/i.test(rm[2]) ? n * 60 : n;
    if (mins >= 5 && mins <= 1440) {
      mutateAppointment(tenant, id, (x) => {
        for (const r of x.reminders || []) if (r.status === "scheduled") { r.status = "cancelled"; r.cancelled_reason = "replaced_by_voice_correction"; }
        x.reminder = `${mins} minutes before`;
        scheduleReminder(tenant, x);
      });
      changed.push(`reminder → ${mins} minutes before`);
    }
  }
  /* recipients: add / remove by voice */
  if (/\b(add|invite|include)\b/i.test(t)) {
    const r = resolveAudience(tenant, t);
    if (r.recipients.length) {
      mutateAppointment(tenant, id, (x) => {
        const cur = x.recipients || [];
        for (const rec of r.recipients) if (!cur.some((c) => c.phone === rec.phone)) cur.push(rec);
        x.recipients = cur;
      });
      changed.push(`recipients +${r.recipients.length}`);
    }
  }
  if (/\bremove\b/i.test(t)) {
    const r = resolveAudience(tenant, t.replace(/\bremove\b/gi, "invite"));
    const dropIds = new Set(r.recipients.map((x) => x.customer_id));
    const dropGroup = GROUPS.find((g) => g.re.test(t));
    mutateAppointment(tenant, id, (x) => {
      x.recipients = (x.recipients || []).filter((c) => !dropIds.has(c.customer_id) && !(dropGroup && (c.group || "") === dropGroup.key));
    });
    changed.push("recipients removed per instruction");
  }

  const { appointment } = mutateAppointment(tenant, id, (x) => {
    if (changed.length) {
      x.approval = null; /* material change invalidates prior authorization */
      x.invitations = null;
      x.events = [...(x.events || []), `Voice correction applied: ${changed.join("; ")} (same appointment ${x.id}; prior approval invalidated)`];
      x.history = [...(x.history || []), { change: "voice_correction", detail: changed, ts: new Date().toISOString() }];
    }
  });
  logEvent(get(tenant), { kind: "APPOINTMENT_CORRECTED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", objective_id: appointment.objective_id || undefined, note: changed.join("; ") || "no material change detected" });
  return { ok: true, appointment, changed, approval_invalidated: changed.length > 0 };
}

/* ---- Availability (native records + honest Google status) ---- */
export function checkAvailability(tenant, id) {
  const { appointment: a } = getAppointment(tenant, id);
  const rows = (getAppointmentList(tenant) || []).filter((r) => r.id !== a.id && r.status !== "Cancelled" && r.date === a.date && r.start < a.end && r.end > a.start);
  const cal = calendarStatus();
  const durMin = (Number(a.end.slice(0, 2)) * 60 + Number(a.end.slice(3))) - (Number(a.start.slice(0, 2)) * 60 + Number(a.start.slice(3)));
  const alternatives = rows.length ? suggestAlternatives(tenant, a.date, durMin, a.start) : [];
  return {
    available: rows.length === 0,
    conflicts: rows.map((r) => ({ id: r.id, title: r.title, start: r.start, end: r.end })),
    alternatives,
    google_calendar: { checked: false, mode: cal.mode, note: cal.configured ? "Live free/busy check requires the calendar.events.readonly scope; not performed by this adapter." : "Google Calendar not connected — only native AIVORA appointments were checked." },
    attendee_availability: "not accessible — no claim made about participant calendars",
  };
}
function getAppointmentList(tenant) { try { return listAppointments(tenant).appointments; } catch { return []; } }

/* ---- Invitation copywriting (per recipient, no cross-recipient data) ---- */
function fmtDateLong(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(date + "T00:00:00+08:00"));
}
function fmtTime12(t) {
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM"; const hh = h % 12 || 12;
  return `${hh}:${pad(m)} ${ap}`;
}
export function composeInvitation(a, r) {
  const loc = a.location || "venue to be confirmed";
  if (r.language === "zh") {
    return `会议邀请\n\n亲爱的 ${r.name}：\n\n诚邀您参加 ${a.title}。\n\n📅 ${fmtDateLong(a.date)}\n🕒 ${fmtTime12(a.start)} – ${fmtTime12(a.end)}（新加坡时间）\n📍 ${loc}\n☕ ${a.agenda || a.title}\n\n请回复“确认”或“无法出席”。期待与您见面。`;
  }
  return `MEETING INVITATION\n\nDear ${r.name},\n\nYou are invited to ${a.title}.\n\n📅 ${fmtDateLong(a.date)}\n🕒 ${fmtTime12(a.start)} – ${fmtTime12(a.end)} (Singapore time)\n📍 ${loc}\n☕ ${a.agenda || a.title}\n\nPlease confirm your attendance. We look forward to seeing you.`;
}

function fingerprint(a) {
  return createHash("sha256").update(JSON.stringify({
    title: a.title, date: a.date, start: a.start, end: a.end, location: a.location,
    reminder: a.reminder, recipients: (a.recipients || []).map((r) => r.customer_id).sort(),
  })).digest("hex");
}

/* Prepare invitations + spoken authorization summary. NO external action here. */
export function prepareInvitations(tenant, id, audienceText) {
  const { appointment: a0 } = getAppointment(tenant, id);
  let recipients = a0.recipients || [];
  let audience = null;
  if (audienceText) {
    audience = resolveAudience(tenant, audienceText);
    recipients = audience.recipients;
    mutateAppointment(tenant, id, (x) => { x.recipients = recipients; x.approval = null; x.invitations = null; });
  }
  if (!recipients.length) throw Object.assign(new Error("No authorized recipients resolved. Say who to invite (e.g. \"invite all my coffee distributors\"). Nothing was invented."), { status: 400 });
  const availability = checkAvailability(tenant, id);
  const { appointment: a } = mutateAppointment(tenant, id, (x) => {
    x.invitations = recipients.map((r) => ({ customer_id: r.customer_id, name: r.name, phone: r.phone, language: r.language, text: composeInvitation(x, r), status: "pending", message_id: null, provider: null }));
    x.events = [...(x.events || []), "TARGET_AUDIENCE_IDENTIFIED", "CONTACTS_RETRIEVED", "RECIPIENTS_VALIDATED", "GOOGLE_CALENDAR_AVAILABILITY_CHECKED (native records)", "WHATSAPP_INVITATIONS_GENERATED"];
  });
  const summary = `Boss, I will create "${a.title}" on ${fmtDateLong(a.date)} at ${fmtTime12(a.start)} and send WhatsApp invitations to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}. Shall I proceed?`;
  return { ok: true, appointment: a, availability, summary, fingerprint: fingerprint(a), whatsapp: whatsappStatus(), audience };
}

/* RogueAI Shield: block silent audience expansion by an agent. */
export function attemptAudienceExpansion(tenant, id, agentId) {
  const { appointment: a } = getAppointment(tenant, id);
  const approved = (a.recipients || []).map((r) => r.customer_id);
  const incident = recordAppointmentSecurityIncident(tenant, { action: `audience expansion on appointment ${id}`, agent_id: agentId || "unknown-agent" });
  mutateAppointment(tenant, id, (x) => {
    x.events = [...(x.events || []), `ROGUEAI_POLICY_EVALUATED — BLOCK: agent ${agentId || "unknown"} attempted to expand the approved audience (${approved.length} recipients). No expansion applied.`];
    x.security_incidents = [...(x.security_incidents || []), { ...incident, agent_id: agentId || "unknown-agent", approved_count: approved.length, ts: new Date().toISOString() }];
  });
  return { blocked: true, incident, approved_count: approved.length, note: "Audience unchanged; incident recorded; agent quarantined from dispatch." };
}

/* Owner-authorized dispatch: calendar first, then WhatsApp per adapter mode. */
export async function authorizeAndDispatch(tenant, id, { approved, expected_fingerprint, actor } = {}) {
  if (approved !== true) throw Object.assign(new Error("Explicit owner approval required before any external action."), { status: 403 });
  if (actor && actor !== "owner") {
    const inc = attemptAudienceExpansion(tenant, id, actor);
    throw Object.assign(new Error("Only the authenticated owner may authorize dispatch."), { status: 403, ...inc });
  }
  const { appointment: a0 } = getAppointment(tenant, id);
  if (!a0.invitations?.length) throw Object.assign(new Error("Prepare invitations first."), { status: 400 });
  const fp = fingerprint(a0);
  if (expected_fingerprint && expected_fingerprint !== fp)
    throw Object.assign(new Error("The appointment changed since you approved it. A fresh confirmation is required."), { status: 409, current_fingerprint: fp });

  mutateAppointment(tenant, id, (x) => {
    x.approval = { fingerprint: fp, approved_at: new Date().toISOString(), actor: "owner" };
    x.events = [...(x.events || []), "VOICE_CONFIRMATION_RECEIVED", "ROGUEAI_POLICY_EVALUATED — ALLOW (owner, bound to appointment version)"];
  });

  /* 1) Calendar registration through the existing owner-confirmation gate. */
  const conf = await confirmAppointment(tenant, id);
  const cal = conf.calendar;
  mutateAppointment(tenant, id, (x) => {
    x.events = [...(x.events || []), cal.configured && cal.ok ? `GOOGLE_CALENDAR_EVENT_CREATED (${cal.event_id})` : "GOOGLE_CALENDAR_EVENT_CREATED — not configured; native record confirmed, .ics export available"];
  });

  /* 2) WhatsApp dispatch — mode-honest, per recipient, idempotent. */
  const wa = whatsappStatus();
  const { appointment: a } = getAppointment(tenant, id);
  const results = [];
  for (const inv of a.invitations) {
    if (inv.message_id) { results.push({ ...inv, skipped: "already submitted — not resent" }); continue; }
    if (wa.mode === "not_configured") {
      mutateAppointment(tenant, id, (x) => { const i = x.invitations.find((y) => y.customer_id === inv.customer_id); i.status = "held_not_configured"; });
      results.push({ customer_id: inv.customer_id, name: inv.name, status: "held_not_configured", message_id: null });
      continue;
    }
    if (wa.mode === "sandbox") {
      const mid = `SANDBOX-wamid.${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      mutateAppointment(tenant, id, (x) => { const i = x.invitations.find((y) => y.customer_id === inv.customer_id); i.status = "submitted_sandbox"; i.message_id = mid; i.provider = "whatsapp-SANDBOX"; i.submitted_at = new Date().toISOString(); });
      results.push({ customer_id: inv.customer_id, name: inv.name, status: "submitted_sandbox", message_id: mid });
      continue;
    }
    /* live official Cloud API */
    try {
      const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: inv.phone, type: "text", text: { body: inv.text } }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => ({}));
      const mid = j?.messages?.[0]?.id || null;
      const status = res.ok && mid ? "submitted" : "failed";
      mutateAppointment(tenant, id, (x) => { const i = x.invitations.find((y) => y.customer_id === inv.customer_id); i.status = status; i.message_id = mid; i.provider = "whatsapp_cloud_api"; i.error = status === "failed" ? (j?.error?.message || `HTTP ${res.status}`) : null; i.submitted_at = new Date().toISOString(); });
      results.push({ customer_id: inv.customer_id, name: inv.name, status, message_id: mid });
    } catch (e) {
      mutateAppointment(tenant, id, (x) => { const i = x.invitations.find((y) => y.customer_id === inv.customer_id); i.status = "failed"; i.error = e.message; });
      results.push({ customer_id: inv.customer_id, name: inv.name, status: "failed", error: e.message });
    }
  }
  const submitted = results.filter((r) => /submitted/.test(r.status)).length;
  const held = results.filter((r) => r.status === "held_not_configured").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const { appointment: final } = mutateAppointment(tenant, id, (x) => {
    x.events = [...(x.events || []),
      wa.mode === "not_configured" ? "WHATSAPP_MESSAGES_SUBMITTED — HELD (adapter not configured; no external call)" : `WHATSAPP_MESSAGES_SUBMITTED (${submitted} ${wa.mode}; delivery not yet confirmed)`,
      "REMINDERS_SCHEDULED (native, via My Inbox)",
      failed ? `APPOINTMENT_WORKFLOW_COMPLETED_WITH_FAILURES (${failed} failed; successful submissions preserved)` : "APPOINTMENT_WORKFLOW_COMPLETED"];
  });
  const ev = { kind: "APPOINTMENT_INVITATIONS_DISPATCHED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", objective_id: final.objective_id || undefined, note: `mode=${wa.mode} submitted=${submitted} held=${held} failed=${failed}` };
  logEvent(get(tenant), ev);
  try { ingestEvent(tenant, { ...ev, mode: wa.mode === "live" ? "LIVE" : "TEST_SIMULATED" }); } catch { /* inbox optional */ }
  return { ok: true, appointment: final, calendar: cal, whatsapp: wa, dispatch: { submitted, held, failed, results }, delivery_note: "Submission is not delivery. Delivered/read status requires provider webhook evidence, which is not configured." };
}

/* ---- RSVP + attendance ---- */
export function recordRsvp(tenant, id, { customer_id, response } = {}) {
  const r = String(response || "").toLowerCase();
  if (!["confirmed", "declined"].includes(r)) throw Object.assign(new Error("response must be confirmed or declined"), { status: 400 });
  const { appointment } = mutateAppointment(tenant, id, (x) => {
    const inv = (x.invitations || []).find((i) => i.customer_id === customer_id);
    if (!inv) throw Object.assign(new Error("Recipient not on this appointment's invitation list."), { status: 404 });
    inv.rsvp = r; inv.rsvp_at = new Date().toISOString();
    x.events = [...(x.events || []), `WHATSAPP_MESSAGE_STATUS_UPDATED — ${inv.name}: ${r}`];
  });
  return { ok: true, appointment };
}
export function attendanceReport(tenant, id) {
  const { appointment: a } = getAppointment(tenant, id);
  const inv = a.invitations || [];
  return {
    appointment_id: id, title: a.title,
    confirmed: inv.filter((i) => i.rsvp === "confirmed").map((i) => i.name),
    declined: inv.filter((i) => i.rsvp === "declined").map((i) => i.name),
    no_reply: inv.filter((i) => !i.rsvp).map((i) => i.name),
    coming: inv.filter((i) => i.rsvp === "confirmed").length,
    total_invited: inv.length,
  };
}