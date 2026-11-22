/* AIVORA V43 Speak-to-Appointment automated test program (AP-001..AP-010).
 * Sandbox: offline memory mode, synthetic contacts, Asia/Singapore,
 * fixed reference date 2026-11-23 (injectable clock). No real invitations,
 * no financial transactions, no external booking calls. */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let child;
const B = "http://127.0.0.1:8331";
const REF = "2026-11-23T09:00:00+08:00"; /* fixed reference: Monday 23 Nov 2026 */
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());
const submit = (text, extra = {}) => post("/api/odai/submit", { text, source: "voice", reference_now: REF, ...extra });
const extract = (text, extra = {}) => post("/api/odai/appointments/extract", { text, reference_now: REF, ...extra });

before(async () => {
  const env = { ...process.env, PORT: "8331", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" };
  delete env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  child = spawn(process.execPath, [serverScript], { env, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
  /* synthetic authorized contacts (stable identifiers -> idempotent across runs) */
  await post("/api/odai/customers", { customer_name: "Coffee Supplier", phone_number: "6590000001", email_address: "supplier@sandbox.test", is_mock_data: true });
  await post("/api/odai/customers", { customer_name: "Distributor Tan", phone_number: "6590000002", is_mock_data: true });
  /* sandbox cleanup: cancel prior synthetic appointments on the fixed test dates */
  const list = await getj("/api/odai/appointments");
  for (const a of list.appointments) {
    if (a.status !== "Cancelled" && ["2026-11-24", "2026-11-27", "2026-11-25", "2026-11-26"].includes(a.date)) await post(`/api/odai/appointments/${a.id}/cancel`, {});
  }
});
after(() => child?.kill());

test("AP-001 basic voice appointment: extraction, contact retrieval, confirm, persistence", async () => {
  const j = (await submit("Arrange a meeting with my coffee supplier tomorrow at two in the afternoon for one hour.")).body;
  assert.equal(j.appointment, true);
  assert.equal(j.draft.contact, "coffee supplier");
  assert.equal(j.draft.title, "Coffee Supplier Meeting");
  assert.equal(j.draft.date, "2026-11-24");
  assert.equal(j.draft.start, "14:00");
  assert.equal(j.draft.end, "15:00");
  assert.equal(j.timezone, "Asia/Singapore");
  assert.ok(j.contact_record, "authorized supplier record retrieved");
  assert.equal(j.contact_record.name, "Coffee Supplier");
  assert.equal(j.question, null);
  const s = await post("/api/odai/appointments", { ...j.draft, objective_id: j.objective_id, idempotency_key: "ap001-" + j.objective_id, contact_record: j.contact_record });
  assert.equal(s.status, 200);
  assert.equal(s.body.appointment.status, "Pending confirmation");
  const c = await post(`/api/odai/appointments/${s.body.appointment.id}/confirm`, {});
  assert.equal(c.body.appointment.status, "Confirmed");
  const list = await getj("/api/odai/appointments");
  const stored = list.appointments.find((a) => a.id === s.body.appointment.id);
  assert.deepEqual({ date: stored.date, start: stored.start, end: stored.end, contact: stored.contact }, { date: "2026-11-24", start: "14:00", end: "15:00", contact: "coffee supplier" });
  assert.equal(stored.objective_id, j.objective_id);
  globalThis.__ap001 = { id: s.body.appointment.id, objective_id: j.objective_id };
});

test("AP-002 relative date: this Friday morning at ten -> 2026-11-27 10:00; identity/duration gating", async () => {
  const j = (await submit("Meet my customer this Friday morning at ten.")).body;
  assert.equal(j.appointment, true);
  assert.equal(j.draft.date, "2026-11-27");
  assert.equal(j.draft.start, "10:00");
  assert.equal(j.timezone, "Asia/Singapore");
  assert.equal(j.duration_explicit, false, "duration not stated -> configured default, flagged");
  assert.equal(j.draft.end, "11:00");
  assert.ok(j.missing.length > 0 || j.contact_candidates.length > 0, "customer identity requested when unresolved");
  const bad = await post("/api/odai/appointments", { title: "Incomplete", contact: "", date: j.draft.date, start: j.draft.start, end: j.draft.end });
  assert.equal(bad.status, 400, "registration prevented while mandatory info unresolved");
});

test("AP-003 Mandarin appointment uses the same unified /submit handler", async () => {
  const j = (await submit("明天下午三点安排一个客户会议。")).body;
  assert.equal(j.appointment, true);
  assert.equal(j.draft.type, "Customer Meeting");
  assert.equal(j.draft.date, "2026-11-24");
  assert.equal(j.draft.start, "15:00");
  assert.equal(j.timezone, "Asia/Singapore");
  assert.ok(j.missing.length > 0, "identity/duration follow-up where necessary");
});

test("AP-004 incomplete appointment: objective preserved, no incomplete confirm, saved exactly once", async () => {
  const oid = "OBJ-AP004-TEST";
  const j = (await submit("Help me arrange a meeting with my distributor.", { objective_id: oid })).body;
  assert.equal(j.appointment, true);
  assert.equal(j.objective_id, oid);
  assert.equal(j.draft.contact, "distributor");
  assert.ok(j.missing.some((m) => /day|time/i.test(m)), "missing date/time requested");
  const follow = await extract("The distributor meeting is on 2026-11-25 at 3 PM for one hour.", { objective_id: oid });
  assert.equal(follow.body.objective_id, oid, "objective ID preserved across follow-up");
  const incomplete = await post("/api/odai/appointments", { title: "Distributor", contact: "distributor", date: "", start: "", end: "", objective_id: oid });
  assert.equal(incomplete.status, 400);
  const fields = { ...follow.body.draft, contact: "Distributor Tan", objective_id: oid, idempotency_key: "ap004-" + oid };
  const s1 = await post("/api/odai/appointments", fields);
  assert.equal(s1.status, 200);
  const s2 = await post("/api/odai/appointments", fields);
  assert.equal(s2.body.deduped, true, "replay deduplicated");
  assert.equal(s2.body.appointment.id, s1.body.appointment.id);
  const list = await getj("/api/odai/appointments");
  assert.equal(list.appointments.filter((a) => a.idempotency_key === "ap004-" + oid).length, 1, "saved exactly once");
});

test("AP-005 conflict: overlap detected, alternatives from real records, no unintended overlap", async () => {
  const beforeCount = (await getj("/api/odai/appointments")).appointments.filter((a) => a.status !== "Cancelled").length;
  const j = (await submit("Arrange another meeting tomorrow at two thirty for one hour.")).body;
  assert.equal(j.draft.start, "14:30");
  const s = await post("/api/odai/appointments", { ...j.draft, contact: "Another party", title: "Conflict probe" });
  assert.equal(s.status, 409);
  assert.ok(s.body.conflicting_appointment, "conflicting appointment displayed");
  assert.ok(Array.isArray(s.body.alternatives) && s.body.alternatives.length > 0, "alternatives suggested from actual calendar");
  const afterCount = (await getj("/api/odai/appointments")).appointments.filter((a) => a.status !== "Cancelled").length;
  assert.equal(afterCount, beforeCount, "no unintended overlapping appointment created");
  const alt = s.body.alternatives[0];
  const ok = await post("/api/odai/appointments", { title: "Alternative slot", contact: "Another party", date: alt.date, start: alt.start, end: alt.end });
  assert.equal(ok.status, 200, "owner-confirmed alternative registers");
});

test("AP-006 reschedule: ID preserved, duration kept, conflicts rechecked, reminder replaced, history recorded", async () => {
  const id = globalThis.__ap001.id;
  const r = await post(`/api/odai/appointments/${id}/reschedule`, { start: "16:00" });
  assert.equal(r.status, 200);
  const a = r.body.appointment;
  assert.equal(a.id, id);
  assert.equal(a.start, "16:00");
  assert.equal(a.end, "17:00");
  assert.ok(a.history.some((h) => h.change === "reschedule" && h.from.start === "14:00" && h.to.start === "16:00"));
  const scheduled = a.reminders.filter((x) => x.status === "scheduled");
  assert.equal(scheduled.length, 1, "exactly one active reminder after reschedule");
  assert.ok(a.reminders.some((x) => x.status === "cancelled" && x.cancelled_reason === "replaced_by_reschedule"));
  assert.equal(scheduled[0].reminder_at, "2026-11-24T15:30:00+08:00");
  const list = (await getj("/api/odai/appointments")).appointments;
  assert.equal(list.filter((x) => x.id === id).length, 1, "no duplicate appointment");
});

test("AP-007 Calendly: honest BLOCKED for live booking; native provider (ICS) verified independently", async () => {
  const cs = await getj("/api/odai/appointments/calendar-status");
  assert.equal(cs.calendly_booking_url, "https://calendly.com/pingfaninsg");
  assert.equal(cs.configured, false, "no runtime calendar credential -> no live external booking claimed");
  const id = globalThis.__ap001.id;
  const r = await fetch(`${B}/api/odai/appointments/${id}/ics`);
  assert.equal(r.status, 200);
  const ics = await r.text();
  assert.match(ics, /DTSTART;TZID=Asia\/Singapore:20261124T160000/);
  assert.match(ics, /STATUS:CONFIRMED/);
  /* live external booking remains BLOCKED: no booking API/credential in runtime; prepared link is NOT a completed booking */
});

test("AP-008 RogueAI Shield: cross-workspace read/modify denied, incident recorded, legitimate ops functional", async () => {
  const id = globalThis.__ap001.id;
  const read = await fetch(`${B}/api/odai/appointments?tenant=rogue-sandbox-workspace`);
  assert.equal(read.status, 403);
  const mod = await post(`/api/odai/appointments/${id}/reschedule?tenant=rogue-sandbox-workspace`, { start: "09:00" });
  assert.equal(mod.status, 403);
  const again = await fetch(`${B}/api/odai/appointments?tenant=rogue-sandbox-workspace`);
  assert.equal(again.status, 403, "subsequent unauthorized request denied");
  const orig = (await getj(`/api/odai/appointments/${id}`)).appointment;
  assert.equal(orig.start, "16:00", "original appointment unchanged");
  const inbox = await getj("/api/odai/inbox?category=SECURITY");
  assert.ok(inbox.messages.some((m) => m.notification_type === "APPOINTMENT_ACCESS_DENIED"), "security incident recorded in SHIELD/inbox evidence");
  const legit = await getj("/api/odai/appointments");
  assert.ok(Array.isArray(legit.appointments), "legitimate operations remain functional");
});

test("AP-009 automation healing: post-commit failure reconciled, exactly one appointment + one reminder; pre-commit safe", async () => {
  const key = "ap009-" + Date.now();
  const fields = { title: "Healing probe", contact: "Coffee Supplier", date: "2026-11-25", start: "09:00", end: "10:00", idempotency_key: key, objective_id: "OBJ-AP009" };
  const fail = await post("/api/odai/appointments", { ...fields, inject_failure: "after_commit" });
  assert.equal(fail.status, 500);
  assert.equal(fail.body.code, "INJECTED_DELIVERY_FAILURE");
  const rec = await post("/api/odai/appointments/reconcile", { idempotency_key: key });
  assert.equal(rec.body.found, true);
  assert.equal(rec.body.healed, true);
  assert.equal(rec.body.duplicates, 0);
  assert.equal(rec.body.active_reminders, 1);
  const retry = await post("/api/odai/appointments", fields);
  assert.equal(retry.body.deduped, true, "reconcile-before-retry prevents duplicate");
  const list = (await getj("/api/odai/appointments")).appointments;
  assert.equal(list.filter((a) => a.idempotency_key === key).length, 1);
  const key2 = "ap009pre-" + Date.now();
  const pre = await post("/api/odai/appointments", { ...fields, date: "2026-11-26", idempotency_key: key2, inject_failure: "before_commit" });
  assert.equal(pre.status, 500);
  const rec2 = await post("/api/odai/appointments/reconcile", { idempotency_key: key2 });
  assert.equal(rec2.body.found, false, "nothing committed before failure");
  const ok = await post("/api/odai/appointments", { ...fields, date: "2026-11-26", idempotency_key: key2 });
  assert.equal(ok.status, 200);
  assert.equal((await getj("/api/odai/appointments")).appointments.filter((a) => a.idempotency_key === key2).length, 1);
});

test("AP-010 reminders: voice request, injectable-clock delivery via Inbox, replace on reschedule, cancel clears", async () => {
  const j = (await submit("Remind me thirty minutes before my coffee supplier meeting.")).body;
  assert.equal(j.reminder_request, true);
  assert.equal(j.appointment.id, globalThis.__ap001.id);
  assert.equal(j.active_reminders, 1);
  assert.equal(j.reminder.reminder_at, "2026-11-24T15:30:00+08:00");
  const tick = await post("/api/odai/appointments/reminders/tick", { now: "2026-11-24T15:31:00+08:00" });
  assert.ok(tick.body.delivered.some((d) => d.appointment_id === globalThis.__ap001.id), "reminder delivered without waiting for real date");
  const inbox = await getj("/api/odai/inbox?category=ALL");
  assert.ok(inbox.messages.some((m) => m.notification_type === "APPOINTMENT_REMINDER"), "delivery through My Inbox infrastructure");
  const r = await post(`/api/odai/appointments/${globalThis.__ap001.id}/reschedule`, { start: "17:00" });
  assert.equal(r.body.appointment.reminders.filter((x) => x.status === "scheduled").length, 1);
  assert.equal(r.body.reminder.reminder_at, "2026-11-24T16:30:00+08:00");
  const c = await post(`/api/odai/appointments/${globalThis.__ap001.id}/cancel`, {});
  assert.equal(c.body.active_reminders, 0, "no active reminder after cancellation");
  const tick2 = await post("/api/odai/appointments/reminders/tick", { now: "2026-11-24T18:00:00+08:00" });
  assert.ok(!tick2.body.delivered.some((d) => d.appointment_id === globalThis.__ap001.id), "cancelled appointment delivers nothing");
});