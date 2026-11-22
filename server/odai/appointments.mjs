/* AIVORA Appointment engine — voice/text -> extraction -> owner confirmation ->
 * persisted appointment -> calendar output.
 * Honesty rules: extraction is deterministic (no fabricated model output);
 * Google Calendar sync only reports success when the provider confirms it;
 * without credentials the adapter reports NOT_CONFIGURED and the ICS export
 * remains the working bridge into any calendar (incl. Google Calendar import).
 * V43 test-program additions (additive): word-number + Mandarin extraction,
 * authorized contact retrieval, idempotency + automation healing, reschedule/
 * cancel with history, persistent reminders delivered through My Inbox,
 * conflict alternatives from actual records, security incident recording.
 */
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOffline } from "./db.mjs";
import { get, logEvent, DEMO_TENANT } from "./store.mjs";
import { searchCustomers } from "./customers.mjs";
import { ingestEvent } from "./inbox.mjs";

const root = fileURLToPath(new URL("../../odai/appointments/", import.meta.url));
const TZ = "Asia/Singapore";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function scope(tenant) {
  if (!isOffline()) throw Object.assign(new Error("Online appointments blocked: validated auth membership and calendar persistence schema are not integrated. No memory fallback."), { status: 503 });
  if (!tenant) throw Object.assign(new Error("Appointment scope denied"), { status: 403 });
  return tenant;
}
function filename(tenant) { return root + createHash("sha256").update(tenant).digest("hex") + ".json"; }
function load(tenant) {
  try { const d = JSON.parse(readFileSync(filename(tenant), "utf8")); if (!Array.isArray(d)) throw new Error("Invalid appointment store"); return d; }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function persist(tenant, rows) {
  mkdirSync(root, { recursive: true });
  const dest = filename(tenant), tmp = dest + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 }); renameSync(tmp, dest);
}

export function appointmentIntent(text) {
  const t = String(text || "");
  return /\b(appointment|schedule (a |an |my )?(meeting|call|appointment)|arrange (a |an )?(meeting|call)|book (a |an )?(meeting|call|appointment)|set up (a |an )?(meeting|call)|meet(ing)? with|meet (my|the|our) |remind me to meet)\b/i.test(t)
    || /(安排|预约|预订).{0,12}(会议|见面|appointment)/i.test(t)
    || /\b(remind me (thirty|30|sixty|60|fifteen|15) minutes before)\b/i.test(t)
    || /\b(change|reschedule|move|cancel)\b.*\b(meeting|appointment)\b/i.test(t);
}

function sgToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const p = (t) => parts.find((x) => x.type === t)?.value || "";
  return new Date(Date.UTC(Number(p("year")), Number(p("month")) - 1, Number(p("day"))));
}
const iso = (d) => d.toISOString().slice(0, 10);

const WORD_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
function cnHour(s) { if (CN_NUM[s] != null) return CN_NUM[s]; if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_NUM[s[1]]; if (/^[一二两三四五六七八九]十$/.test(s)) return CN_NUM[s[0]] * 10; return null; }
const pad = (n) => String(n).padStart(2, "0");
function fmtTime(h, m) { return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : ""; }

/* Deterministic extraction from a confirmed transcript or typed instruction.
 * opts: { tenant, objective_id } — tenant enables authorized contact retrieval. */
export function extractAppointment(text, now = new Date(), opts = {}) {
  const t = String(text || "").trim();
  const missing = [];
  const isZh = /[\u4e00-\u9fff]/.test(t);
  let contact = "";
  let typeHint = "";
  if (isZh) {
    if (/客户会议|客户见面|见客户|客户开会/.test(t)) { contact = "customer"; typeHint = "Customer Meeting"; }
    else if (/供应商/.test(t)) { contact = "supplier"; typeHint = "Supplier Meeting"; }
    else if (/分销商|经销商/.test(t)) { contact = "distributor"; typeHint = "Distributor Meeting"; }
    const zm = t.match(/(?:与|和|跟|同)\s*([^,，.。;；!！?？\s]{1,20}?)(?=\s*(?:在|于|明天|今天|后天|开会|见面|会议|$))/);
    if (zm && !contact) contact = zm[1];
  } else {
    const cm = t.match(/(?:meeting|meet|appointment|call|see)\s+with\s+(?:my\s+|the\s+|our\s+)?([^,.;!?]+?)(?=\s+(?:on|at|tomorrow|today|next|this|for)\b|[,.!?]|$)/i)
      || t.match(/(?:arrange|schedule|book|set up)\s+(?:a\s+|an\s+)?(?:meeting|call|appointment)\s+with\s+(?:my\s+|the\s+|our\s+)?([^,.;!?]+?)(?=\s+(?:on|at|tomorrow|today|next|this|for)\b|[,.!?]|$)/i)
      || t.match(/\bmeet\s+(?:my\s+|the\s+|our\s+)?([^,.;!?]+?)(?=\s+(?:on|at|tomorrow|today|next|this|for)\b|[,.!?]|$)/i);
    if (cm) contact = cm[1].trim();
  }
  if (!contact) missing.push("Who are you meeting? (contact name)");

  let date = "";
  const day = sgToday(now);
  if (/\btomorrow\b/i.test(t) || /明天/.test(t)) { day.setUTCDate(day.getUTCDate() + 1); date = iso(day); }
  else if (/\btoday\b/i.test(t) || /今天/.test(t)) date = iso(day);
  else if (/后天/.test(t)) { day.setUTCDate(day.getUTCDate() + 2); date = iso(day); }
  else {
    const dm = t.toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    const zhDay = t.match(/(?:星期|周)([一二三四五六日天])/);
    const zhMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    if (dm || zhDay) {
      const target = dm ? DAYS.indexOf(dm[1]) : zhMap[zhDay[1]];
      let delta = (target - day.getUTCDay() + 7) % 7;
      const explicitDate = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (explicitDate) date = explicitDate[1];
      else { if (!delta) delta = 7; day.setUTCDate(day.getUTCDate() + delta); date = iso(day); }
    } else {
      const explicitDate = t.match(/\b(\d{4}-\d{2}-\d{2})\b/) || t.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/);
      if (explicitDate) date = explicitDate[3] ? `${explicitDate[1]}-${pad(Number(explicitDate[2]))}-${pad(Number(explicitDate[3]))}` : explicitDate[1];
    }
  }
  if (!date) missing.push("Which day should the meeting be?");

  /* Time: numeric HH:MM / h am|pm, English word numbers with daypart, Mandarin 点. */
  let start = "", end = "";
  const daypart = /afternoon|evening|\bpm\b|下午|晚上|傍晚/i.test(t) ? "pm" : /morning|\bam\b|上午|早上|中午/i.test(t) ? "am" : "";
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm) {
    let h = Number(tm[1]); const min = tm[2] ? Number(tm[2]) : 0;
    if (/pm/i.test(tm[3] || "") && h < 12) h += 12;
    if (/am/i.test(tm[3] || "") && h === 12) h = 0;
    start = fmtTime(h, min);
  }
  if (!start) {
    const wm = t.match(/\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(thirty|fifteen|forty-five|oh\s+\w+))?\s*(?:(in\s+the\s+)?(morning|afternoon|evening))?\b/i);
    if (wm) {
      let h = WORD_NUM[wm[1].toLowerCase()];
      let min = wm[2] ? (WORD_NUM[wm[2].toLowerCase()] ?? (/fifteen/.test(wm[2]) ? 15 : /forty/.test(wm[2]) ? 45 : 0)) : 0;
      const part = (wm[4] || "").toLowerCase() || daypart;
      if (part === "afternoon" || part === "evening") { if (h < 12) h += 12; }
      else if (part === "morning") { if (h === 12) h = 0; }
      else if (h >= 1 && h <= 7) h += 12; /* business-hours default for bare early hours; documented */
      start = fmtTime(h, min);
    }
  }
  if (!start && isZh) {
    const zm = t.match(/(上午|早上|中午|下午|晚上|傍晚)?\s*([一二两三四五六七八九十]{1,3})\s*点\s*(半|[一二三四五六七八九]?十?[一二三四五六七八九]?)?/);
    if (zm) {
      let h = cnHour(zm[2]);
      let min = zm[3] === "半" ? 30 : zm[3] ? (cnHour(zm[3]) ?? 0) : 0;
      if (h != null) {
        const part = zm[1] || "";
        if (/下午|晚上|傍晚/.test(part) && h < 12) h += 12;
        if (/中午/.test(part) && h < 11) h += 12;
        start = fmtTime(h, min);
      }
    }
  }
  if (!start) missing.push("What time should it start?");

  let minutes = 60;
  let durationExplicit = false;
  const dur = t.match(/\bfor\s+(?:(\d+)|one|an?|half\s+an?)\s*(hours?|hrs?|minutes?|mins?)\b/i);
  if (dur) {
    const n = dur[1] ? Number(dur[1]) : /half/i.test(dur[0]) ? 0.5 : 1;
    minutes = /min/i.test(dur[2]) ? Math.round(n) : Math.round(n * 60);
    if (minutes < 5 || minutes > 480) minutes = 60;
    durationExplicit = true;
  }
  const zhDur = t.match(/([一二两三四五六七八九十\d]+)\s*(个?小时|分钟)/);
  if (zhDur) { const n = cnHour(zhDur[1]) ?? Number(zhDur[1]); minutes = /小时/.test(zhDur[2]) ? Math.round(n * 60) : Math.round(n); durationExplicit = true; }
  if (start) {
    const [h, m] = start.split(":").map(Number);
    const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
    end = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  }

  /* Authorized contact retrieval — never invent supplier/customer details. */
  let contact_record = null, contact_candidates = [];
  if (opts.tenant && contact) {
    try {
      const r = searchCustomers(opts.tenant, { q: contact, pageSize: 5 });
      const list = r.customers || r.results || [];
      if (list.length === 1) contact_record = { customer_id: list[0].customer_id, name: list[0].customer_name, phone: list[0].phone_number || "", email: list[0].email_address || "", source: "authorized_customer_records" };
      else if (list.length > 1) { contact_candidates = list.map((c) => ({ customer_id: c.customer_id, name: c.customer_name })); missing.push(`Which ${contact} do you mean? ${contact_candidates.map((c) => c.name).join(", ")}`); }
      else missing.push(`No authorized record found for "${contact}". Who exactly are you meeting (name or record)?`);
    } catch { /* contact store unavailable offline — identity question still asked below if generic */ }
  }

  const titleBase = typeHint || (contact ? `${contact.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")} Meeting` : t.slice(0, 80));
  const objective_id = opts.objective_id || `OBJ-APPT-${randomUUID().slice(0, 8)}`;
  return {
    objective_id,
    draft: { title: titleBase, contact, phone: contact_record?.phone || "", email: contact_record?.email || "", date, start, end, type: typeHint || (/phone|call/i.test(t) ? "Telephone meeting" : /online|zoom|video/i.test(t) ? "Online meeting" : "Physical meeting"), location: "", agenda: t, reminder: "30 minutes before" },
    missing,
    question: missing.length ? missing[0] : null,
    contact_record,
    contact_candidates,
    duration_explicit: durationExplicit,
    source_text: t,
    timezone: TZ,
  };
}

function validate(a) {
  if (!a.title?.trim() || !a.contact?.trim() || !a.date || !a.start || !a.end)
    throw Object.assign(new Error("Title, contact, date and start/end times are required."), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || !/^\d{2}:\d{2}$/.test(a.start) || !/^\d{2}:\d{2}$/.test(a.end))
    throw Object.assign(new Error("Invalid date or time format."), { status: 400 });
  if (a.end <= a.start) throw Object.assign(new Error("End time must be after start time."), { status: 400 });
}

/* Free-slot suggestions computed from actual stored calendar records. */
export function suggestAlternatives(tenant, date, minutes, aroundStart) {
  scope(tenant);
  const rows = load(tenant).filter((r) => r.status !== "Cancelled" && r.date === date);
  const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const busy = rows.map((r) => [toMin(r.start), toMin(r.end)]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let cursor = 8 * 60; /* business day 08:00-18:00 */
  const want = aroundStart ? toMin(aroundStart) : 9 * 60;
  const candidates = [];
  for (const [bs, be] of busy) { if (bs - cursor >= minutes) candidates.push(cursor); cursor = Math.max(cursor, be); }
  if (18 * 60 - cursor >= minutes) candidates.push(cursor);
  candidates.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  for (const c of candidates.slice(0, 3)) out.push({ date, start: `${pad(Math.floor(c / 60))}:${pad(c % 60)}`, end: `${pad(Math.floor((c + minutes) / 60))}:${pad((c + minutes) % 60)}` });
  return out;
}

function reminderMinutes(reminder) {
  const m = String(reminder || "").match(/(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
  if (!m) return 30;
  const n = Number(m[1]);
  return /hour|hr/i.test(m[2]) ? n * 60 : n;
}
function reminderAt(date, start, minutesBefore) {
  const [h, m] = start.split(":").map(Number);
  let total = h * 60 + m - minutesBefore;
  const d = new Date(date + "T00:00:00Z");
  while (total < 0) { total += 1440; d.setUTCDate(d.getUTCDate() - 1); }
  return `${iso(d)}T${pad(Math.floor(total / 60))}:${pad(total % 60)}:00+08:00`;
}
export function scheduleReminder(tenant, a) {
  const mins = reminderMinutes(a.reminder);
  const rem = { id: randomUUID(), appointment_id: a.id, reminder_at: reminderAt(a.date, a.start, mins), minutes_before: mins, status: "scheduled", delivered: false, created_at: new Date().toISOString() };
  a.reminders = [...(a.reminders || []), rem];
  return rem;
}

export function listAppointments(tenant) {
  scope(tenant);
  return { appointments: load(tenant), calendar: calendarStatus() };
}
export function getAppointment(tenant, id) {
  scope(tenant);
  const a = load(tenant).find((r) => r.id === id);
  if (!a) throw Object.assign(new Error("Appointment not found."), { status: 404 });
  return { appointment: a };
}

/* opts: { inject_failure: "after_commit"|"before_commit" } — offline test hook only. */
export function saveAppointment(tenant, fields, opts = {}) {
  scope(tenant);
  const rows = load(tenant);
  if (fields.idempotency_key) {
    const existing = rows.find((r) => r.idempotency_key === fields.idempotency_key);
    if (existing) return { ok: true, deduped: true, appointment: existing };
  }
  const a = {
    id: String(fields.id || randomUUID()),
    title: String(fields.title || "").trim(), contact: String(fields.contact || "").trim(),
    phone: String(fields.phone || ""), email: String(fields.email || ""),
    date: String(fields.date || ""), start: String(fields.start || ""), end: String(fields.end || ""),
    type: String(fields.type || "Physical meeting"), location: String(fields.location || ""),
    agenda: String(fields.agenda || ""), reminder: String(fields.reminder || "30 minutes before"),
    status: "Pending confirmation", created_at: new Date().toISOString(),
    source_text: String(fields.source_text || ""), events: [],
    objective_id: fields.objective_id ? String(fields.objective_id) : null,
    idempotency_key: fields.idempotency_key ? String(fields.idempotency_key) : null,
    contact_record: fields.contact_record || null,
    history: [], reminders: [],
  };
  validate(a);
  const clash = rows.find((r) => r.id !== a.id && r.status !== "Cancelled" && r.date === a.date && r.start < a.end && r.end > a.start);
  if (clash) {
    const err = Object.assign(new Error(`This time overlaps appointment "${clash.title}". Choose another time.`), { status: 409 });
    err.conflicting_appointment = { id: clash.id, title: clash.title, date: clash.date, start: clash.start, end: clash.end };
    err.alternatives = suggestAlternatives(tenant, a.date, (Number(a.end.slice(0, 2)) * 60 + Number(a.end.slice(3))) - (Number(a.start.slice(0, 2)) * 60 + Number(a.start.slice(3))), a.start);
    throw err;
  }
  if (opts.inject_failure === "before_commit") {
    logEvent(get(tenant), { kind: "TASK_FAILED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "orchestrator", note: "Injected pre-commit failure; nothing persisted." });
    throw Object.assign(new Error("Injected failure before database commit (test hook)."), { status: 500, code: "INJECTED_PRE_COMMIT_FAILURE" });
  }
  const next = [...rows.filter((r) => r.id !== a.id), a];
  persist(tenant, next);
  a.events.push("Appointment details validated", "Local calendar conflict check passed", "Awaiting owner confirmation");
  const rem = scheduleReminder(tenant, a);
  a.events.push(`Reminder scheduled for ${rem.reminder_at}`);
  persist(tenant, next);
  logEvent(get(tenant), { kind: "APPOINTMENT_SAVED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", note: "Appointment draft saved; not yet confirmed." });
  if (opts.inject_failure === "after_commit") {
    logEvent(get(tenant), { kind: "TASK_FAILED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "orchestrator", note: "Injected post-commit delivery failure; commit exists, response lost." });
    throw Object.assign(new Error("Injected failure after database commit (test hook). Reconcile before retry."), { status: 500, code: "INJECTED_DELIVERY_FAILURE", appointment_id: a.id, idempotency_key: a.idempotency_key });
  }
  return { ok: true, appointment: a };
}

/* Automation Healing: reconcile a committed-but-unacknowledged save. Never blind-retry. */
export function reconcileAppointment(tenant, { idempotency_key, appointment_id } = {}) {
  scope(tenant);
  const rows = load(tenant);
  const a = rows.find((r) => (idempotency_key && r.idempotency_key === idempotency_key) || (appointment_id && r.id === appointment_id));
  if (!a) return { ok: true, found: false, duplicates: 0, active_reminders: 0, note: "No committed record found; a single fresh save is safe." };
  const duplicates = rows.filter((r) => r.id !== a.id && (r.idempotency_key && r.idempotency_key === a.idempotency_key)).length;
  const active = (a.reminders || []).filter((r) => r.status === "scheduled").length;
  a.healed = true;
  a.events.push("Automation Healing activated", "Existing appointment status reconciled", "Original appointment recovered", `Duplicate prevention verified (${duplicates} duplicates)`, `Exactly ${active} active reminder(s)`);
  persist(tenant, rows);
  const ev = { kind: "SELF_HEAL", event_id: randomUUID(), ts: new Date().toISOString(), actor: "orchestrator", objective_id: a.objective_id || undefined, note: "Appointment save reconciled after injected delivery failure." };
  logEvent(get(tenant), ev);
  try { ingestEvent(tenant, { ...ev, mode: "TEST_SIMULATED" }); } catch { /* inbox optional */ }
  return { ok: true, found: true, healed: true, appointment: a, duplicates, active_reminders: active };
}

/* Owner confirmation gate. Calendar sync is attempted only here, and its
 * result is reported exactly as the provider returned it. */
export async function confirmAppointment(tenant, id) {
  scope(tenant);
  const rows = load(tenant);
  const a = rows.find((r) => r.id === id);
  if (!a) throw Object.assign(new Error("Appointment not found."), { status: 404 });
  if (a.status === "Confirmed") return { ok: true, appointment: a, calendar: a.calendar_sync || calendarStatus() };
  a.status = "Confirmed";
  a.confirmed_at = new Date().toISOString();
  a.events.push("Owner confirmation received", "Appointment confirmed and persisted");
  const sync = await syncToGoogleCalendar(a);
  a.calendar_sync = sync;
  a.events.push(sync.configured
    ? (sync.ok ? `Google Calendar event created (${sync.event_id})` : `Google Calendar sync failed: ${sync.error}`)
    : "Google Calendar sync not configured — use the .ics export or Calendly booking link");
  persist(tenant, rows);
  logEvent(get(tenant), { kind: "APPOINTMENT_CONFIRMED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", note: "Owner confirmed the appointment." });
  try { ingestEvent(tenant, { kind: "APPOINTMENT_REGISTERED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", objective_id: a.objective_id || undefined }); } catch { /* inbox optional */ }
  return { ok: true, appointment: a, calendar: sync };
}

/* Reschedule: preserve ID and duration, recheck conflicts, replace reminder, record history. */
export function rescheduleAppointment(tenant, id, { date, start } = {}) {
  scope(tenant);
  const rows = load(tenant);
  const a = rows.find((r) => r.id === id);
  if (!a) throw Object.assign(new Error("Appointment not found."), { status: 404 });
  if (a.status === "Cancelled") throw Object.assign(new Error("Cannot reschedule a cancelled appointment."), { status: 409 });
  const newDate = date || a.date;
  const newStart = start || a.start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || !/^\d{2}:\d{2}$/.test(newStart)) throw Object.assign(new Error("Invalid date or time format."), { status: 400 });
  const durMin = (Number(a.end.slice(0, 2)) * 60 + Number(a.end.slice(3))) - (Number(a.start.slice(0, 2)) * 60 + Number(a.start.slice(3)));
  const total = Number(newStart.slice(0, 2)) * 60 + Number(newStart.slice(3)) + durMin;
  if (total > 23 * 60 + 59) throw Object.assign(new Error("Rescheduled end time exceeds the day."), { status: 400 });
  const newEnd = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  const clash = rows.find((r) => r.id !== a.id && r.status !== "Cancelled" && r.date === newDate && r.start < newEnd && r.end > newStart);
  if (clash) {
    const err = Object.assign(new Error(`This time overlaps appointment "${clash.title}". Choose another time.`), { status: 409 });
    err.conflicting_appointment = { id: clash.id, title: clash.title, date: clash.date, start: clash.start, end: clash.end };
    err.alternatives = suggestAlternatives(tenant, newDate, durMin, newStart);
    throw err;
  }
  const from = { date: a.date, start: a.start, end: a.end };
  a.history = [...(a.history || []), { change: "reschedule", from, to: { date: newDate, start: newStart, end: newEnd }, ts: new Date().toISOString() }];
  for (const r of a.reminders || []) if (r.status === "scheduled") { r.status = "cancelled"; r.cancelled_reason = "replaced_by_reschedule"; }
  a.date = newDate; a.start = newStart; a.end = newEnd;
  const rem = scheduleReminder(tenant, a);
  a.events.push(`Rescheduled to ${newDate} ${newStart}-${newEnd} (ID preserved)`, `Old reminder cancelled; new reminder scheduled for ${rem.reminder_at}`);
  persist(tenant, rows);
  logEvent(get(tenant), { kind: "APPOINTMENT_RESCHEDULED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", objective_id: a.objective_id || undefined, note: `Appointment ${a.id} rescheduled; no duplicate created.` });
  return { ok: true, appointment: a, reminder: rem };
}

export function cancelAppointment(tenant, id) {
  scope(tenant);
  const rows = load(tenant);
  const a = rows.find((r) => r.id === id);
  if (!a) throw Object.assign(new Error("Appointment not found."), { status: 404 });
  a.status = "Cancelled";
  a.cancelled_at = new Date().toISOString();
  for (const r of a.reminders || []) if (r.status === "scheduled") { r.status = "cancelled"; r.cancelled_reason = "appointment_cancelled"; }
  a.events.push("Appointment cancelled", "All active reminders cancelled");
  a.history = [...(a.history || []), { change: "cancel", ts: a.cancelled_at }];
  persist(tenant, rows);
  logEvent(get(tenant), { kind: "APPOINTMENT_CANCELLED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", note: `Appointment ${a.id} cancelled; reminders deactivated.` });
  return { ok: true, appointment: a, active_reminders: (a.reminders || []).filter((r) => r.status === "scheduled").length };
}

/* Injectable-clock reminder delivery through the existing My Inbox infrastructure. */
export function deliverDueReminders(tenant, nowISO) {
  scope(tenant);
  const now = nowISO ? new Date(nowISO) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error("Invalid clock value."), { status: 400 });
  const rows = load(tenant);
  const delivered = [];
  for (const a of rows) {
    if (a.status === "Cancelled") continue;
    for (const r of a.reminders || []) {
      if (r.status !== "scheduled" || r.delivered) continue;
      if (new Date(r.reminder_at) <= now) {
        r.delivered = true; r.delivered_at = now.toISOString();
        const ev = { kind: "APPOINTMENT_REMINDER", event_id: `rem-${r.id}`, ts: now.toISOString(), actor: "orchestrator", objective_id: a.objective_id || undefined };
        logEvent(get(tenant), ev);
        try { ingestEvent(tenant, ev); } catch { /* inbox optional */ }
        a.events.push(`Reminder delivered via My Inbox at ${r.delivered_at}`);
        delivered.push({ appointment_id: a.id, reminder_id: r.id, reminder_at: r.reminder_at });
      }
    }
  }
  if (delivered.length) persist(tenant, rows);
  return { ok: true, delivered, clock: now.toISOString() };
}

/* AP-010: "Remind me X minutes before my <contact> meeting" — targets an
 * existing appointment, replaces any prior reminder, persists exactly one. */
export function requestReminder(tenant, text) {
  scope(tenant);
  const t = String(text || "");
  const m = t.match(/(\d+|thirty|sixty|fifteen|ten|twenty)\s*minutes?\s*before/i);
  const mins = m ? (WORD_NUM[m[1].toLowerCase()] ?? Number(m[1])) : 30;
  if (!mins || mins < 5 || mins > 1440) throw Object.assign(new Error("Reminder lead time must be 5-1440 minutes."), { status: 400 });
  const rows = load(tenant).filter((r) => r.status !== "Cancelled");
  const matches = rows.filter((r) => r.contact && t.toLowerCase().includes(r.contact.toLowerCase()));
  const hit = matches.find((r) => r.status === "Confirmed") || matches[0] || (rows.length === 1 ? rows[0] : null);
  if (!hit) throw Object.assign(new Error("Which appointment should the reminder attach to? No unambiguous match found."), { status: 404 });
  for (const r of hit.reminders || []) if (r.status === "scheduled") { r.status = "cancelled"; r.cancelled_reason = "replaced_by_new_request"; }
  hit.reminder = `${mins} minutes before`;
  const rem = scheduleReminder(tenant, hit);
  hit.events.push(`Reminder requested: ${mins} minutes before`, `Reminder scheduled for ${rem.reminder_at}`);
  persist(tenant, load(tenant).map((r) => (r.id === hit.id ? hit : r)));
  logEvent(get(tenant), { kind: "APPOINTMENT_REMINDER_SET", event_id: randomUUID(), ts: new Date().toISOString(), actor: "owner", objective_id: hit.objective_id || undefined, note: `Reminder set for appointment ${hit.id}.` });
  return { ok: true, appointment: hit, reminder: rem, active_reminders: hit.reminders.filter((r) => r.status === "scheduled").length };
}

/* Security incident evidence for denied appointment access (RogueAI Shield). */
export function recordAppointmentSecurityIncident(attemptedTenant, { action, agent_id } = {}) {
  const ev = { kind: "APPOINTMENT_ACCESS_DENIED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "guardrails", decision: "BLOCK", note: `Denied ${action || "access"} on tenant ${String(attemptedTenant).slice(0, 40)}; no protected data returned.` };
  try {
    logEvent(get(DEMO_TENANT), ev);
    ingestEvent(DEMO_TENANT, { ...ev, mode: "TEST_SIMULATED" });
  } catch { /* evidence best-effort; denial itself is enforced by the caller */ }
  return { recorded: true, event_id: ev.event_id };
}

/* Additive helpers for the voice→calendar→WhatsApp workflow module. */
export function mutateAppointment(tenant, id, fn) {
  scope(tenant);
  const rows = load(tenant);
  const a = rows.find((r) => r.id === id);
  if (!a) throw Object.assign(new Error("Appointment not found."), { status: 404 });
  fn(a);
  persist(tenant, rows);
  return { appointment: a };
}
export function findAppointmentByObjective(tenant, objectiveId) {
  scope(tenant);
  return load(tenant).find((r) => r.objective_id && r.objective_id === objectiveId) || null;
}

export function calendarStatus() {
  const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || null;
  return {
    provider: "google_calendar",
    configured: !!token,
    calendar_id: process.env.GOOGLE_CALENDAR_ID || "primary",
    mode: token ? "live" : "not_configured",
    note: token ? "Server-side Google Calendar access token present." : "Set GOOGLE_CALENDAR_ACCESS_TOKEN (server env only) to enable live sync. The .ics export works without credentials.",
    calendly_booking_url: "https://calendly.com/pingfaninsg",
  };
}

export async function syncToGoogleCalendar(a) {
  const status = calendarStatus();
  if (!status.configured) return { ...status, ok: false, blocked: true, error: "GOOGLE_CALENDAR_ACCESS_TOKEN not set; no external call was made." };
  const body = {
    summary: a.title,
    description: `Meeting with: ${a.contact}\nAgenda: ${a.agenda}\nCreated by AIVORA (owner-confirmed).`,
    location: a.location || undefined,
    start: { dateTime: `${a.date}T${a.start}:00+08:00`, timeZone: TZ },
    end: { dateTime: `${a.date}T${a.end}:00+08:00`, timeZone: TZ },
  };
  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(status.calendar_id)}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GOOGLE_CALENDAR_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.id) return { ...status, ok: false, error: j?.error?.message || `Google Calendar HTTP ${res.status}` };
    return { ...status, ok: true, event_id: j.id, htmlLink: j.htmlLink || null };
  } catch (e) {
    return { ...status, ok: false, error: `Google Calendar unreachable: ${e.message}` };
  }
}

/* Standards-compliant ICS — the working, credential-free bridge into Google
 * Calendar (Settings > Import & export) or any calendar app. */
export function appointmentIcs(tenant, id) {
  scope(tenant);
  const a = load(tenant).find((r) => r.id === id);
  if (!a) throw Object.assign(new Error("Appointment not found."), { status: 404 });
  const stamp = (date, time) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AIVORA//Appointment//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${a.id}@aivora.local`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${TZ}:${stamp(a.date, a.start)}`,
    `DTEND;TZID=${TZ}:${stamp(a.date, a.end)}`,
    `SUMMARY:${esc(a.title)}`,
    `DESCRIPTION:${esc(`Meeting with: ${a.contact}. Agenda: ${a.agenda}`)}`,
    ...(a.location ? [`LOCATION:${esc(a.location)}`] : []),
    `STATUS:${a.status === "Confirmed" ? "CONFIRMED" : "TENTATIVE"}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return { filename: `${a.id}.ics`, content: lines.join("\r\n") + "\r\n" };
}