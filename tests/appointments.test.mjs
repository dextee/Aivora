/* Appointment workflow (MAIN-FIX) — voice/text -> extraction -> owner confirmation
 * -> persisted record -> honest calendar output.
 * Verifies: deterministic extraction, /submit intent routing, save+confirm gate,
 * overlap rejection, ICS export, and that Google Calendar sync is NEVER claimed
 * without provider confirmation (unset credential => blocked, no external call). */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let child;
const B = "http://127.0.0.1:8327";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());

before(async () => {
  const env = { ...process.env, PORT: "8327", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" };
  delete env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  child = spawn(process.execPath, [serverScript], { env, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

/* records persist across runs — use a run-unique far-future date to stay idempotent */
const uniqDate = (offsetDays = 0) => { const d = new Date(Date.UTC(2031, 0, 1)); d.setUTCDate(d.getUTCDate() + 20000 + (Date.now() % 100000) + offsetDays); return d.toISOString().slice(0, 10); };

test("extract: 'meeting with my coffee supplier on Tuesday at 2 PM for one hour' parses contact/date/time/duration", async () => {
  const j = (await post("/api/odai/appointments/extract", { text: "Arrange a meeting with my coffee supplier on Tuesday at 2 PM for one hour." })).body;
  assert.equal(j.draft.contact, "coffee supplier");
  assert.equal(j.draft.start, "14:00");
  assert.equal(j.draft.end, "15:00");
  assert.match(j.draft.date, /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date(j.draft.date + "T00:00:00Z");
  assert.equal(d.getUTCDay(), 2, "resolved date is a Tuesday");
  assert.equal(j.question, null);
  assert.equal(j.timezone, "Asia/Singapore");
});

test("extract: missing details produce one short question, nothing invented", async () => {
  const j = (await post("/api/odai/appointments/extract", { text: "Schedule a meeting" })).body;
  assert.ok(j.question, "a follow-up question is asked");
  assert.equal(j.draft.date, "");
  assert.equal(j.draft.start, "");
});

test("/submit routes appointment utterances to the same extraction entry (voice and typed share it)", async () => {
  const j = (await post("/api/odai/submit", { text: "Arrange a meeting with my coffee supplier on Tuesday at 2 PM for one hour.", source: "voice" })).body;
  assert.equal(j.appointment, true);
  assert.equal(j.draft.contact, "coffee supplier");
  assert.equal(j.draft.start, "14:00");
});

test("save + owner confirm: persisted, Confirmed, honest calendar result (no fabricated Google success)", async () => {
  const fields = { title: "Supplier review", contact: "Coffee supplier", date: uniqDate(), start: "14:00", end: "15:00", agenda: "Quarterly review" };
  const s = await post("/api/odai/appointments", fields);
  assert.equal(s.status, 200);
  assert.equal(s.body.appointment.status, "Pending confirmation");
  const c = await post(`/api/odai/appointments/${s.body.appointment.id}/confirm`, {});
  assert.equal(c.status, 200);
  assert.equal(c.body.appointment.status, "Confirmed");
  assert.ok(c.body.appointment.events.some((e) => /Owner confirmation received/.test(e)));
  assert.equal(c.body.calendar.configured, false);
  assert.equal(c.body.calendar.ok, false);
  assert.equal(c.body.calendar.blocked, true);
  assert.ok(!c.body.appointment.events.some((e) => /Google Calendar event created/.test(e)), "no fabricated provider success");
  const list = await getj("/api/odai/appointments");
  assert.ok(list.appointments.some((a) => a.id === s.body.appointment.id && a.status === "Confirmed"), "record persisted server-side");
});

test("overlap rejection: conflicting time is refused, original preserved", async () => {
  const fields = { title: "Overlap probe", contact: "Tester", date: uniqDate(1), start: "09:00", end: "10:00" };
  const a = await post("/api/odai/appointments", fields);
  assert.equal(a.status, 200);
  const b = await post("/api/odai/appointments", { ...fields, title: "Clash", start: "09:30", end: "10:30" });
  assert.equal(b.status, 409);
});

test("ICS export is a valid calendar file importable into Google Calendar", async () => {
  const date = uniqDate(2);
  const s = await post("/api/odai/appointments", { title: "ICS probe", contact: "Tester", date, start: "10:00", end: "11:00" });
  const r = await fetch(`${B}/api/odai/appointments/${s.body.appointment.id}/ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.ok(ics.includes(`DTSTART;TZID=Asia/Singapore:${date.replace(/-/g, "")}T100000`), "DTSTART in Asia/Singapore");
  assert.match(ics, /SUMMARY:ICS probe/);
  assert.match(ics, /END:VCALENDAR/);
});

test("calendar-status reports not_configured honestly when the credential is unset", async () => {
  const j = await getj("/api/odai/appointments/calendar-status");
  assert.equal(j.provider, "google_calendar");
  assert.equal(j.configured, false);
  assert.equal(j.mode, "not_configured");
  assert.equal(j.calendly_booking_url, "https://calendly.com/pingfaninsg");
});