/* Voice→calendar→WhatsApp appointment workflow (MAIN-FIX).
 * Verifies: authorized audience resolution (consent + dedup, nothing invented),
 * voice corrections on the SAME appointment (approval invalidated), invitation
 * preparation + fingerprint-bound owner approval, mode-honest dispatch
 * (held when not configured; labeled SANDBOX when WHATSAPP_SANDBOX=1),
 * RogueAI audience-expansion block, RSVP/attendance, and resend idempotency. */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let plain, sandbox;
const P = "http://127.0.0.1:8329"; /* no WhatsApp credentials */
const S = "http://127.0.0.1:8330"; /* WHATSAPP_SANDBOX=1 */
const post = async (base, u, b) => { const r = await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (base, u) => JSON.parse(await (await fetch(base + u)).text());

async function boot(env, base) {
  const child = spawn(process.execPath, [serverScript], { env: { ...process.env, HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1", ...env }, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot " + base); await new Promise((r) => setTimeout(r, 300)); }
  return child;
}
before(async () => {
  const clean = { ...process.env };
  delete clean.GOOGLE_CALENDAR_ACCESS_TOKEN; delete clean.WHATSAPP_ACCESS_TOKEN; delete clean.WHATSAPP_PHONE_NUMBER_ID; delete clean.WHATSAPP_SANDBOX;
  process.env = clean;
  plain = await boot({ PORT: "8329" }, P);
  sandbox = await boot({ PORT: "8330", WHATSAPP_SANDBOX: "1" }, S);
});
after(() => { plain?.kill(); sandbox?.kill(); });

const uniqDate = (offsetDays = 0) => { const d = new Date(Date.UTC(2031, 0, 1)); d.setUTCDate(d.getUTCDate() + 30000 + (Date.now() % 100000) + offsetDays); return d.toISOString().slice(0, 10); };
const run = Date.now().toString(36);

async function seedDistributors(base) {
  const mk = (name, phone, consent, notes) => post(base, "/api/odai/customers", { customer_name: name, phone_number: phone, marketing_consent: consent, customer_notes: notes, preferred_language: "en" });
  const a = (await mk(`Dist Alpha ${run}`, "6591110001", true, "coffee distributor")).body;
  const b = (await mk(`Dist Beta ${run}`, "6591110002", true, "coffee distributor")).body;
  await mk(`Dist NoConsent ${run}`, "6591110003", false, "coffee distributor");
  await mk(`Dist Dup ${run}`, "6591110001", true, "coffee distributor"); /* same phone → dedup */
  return [a, b];
}
async function makeAppointment(base, date, objectiveId) {
  const ex = (await post(base, "/api/odai/appointments/extract", { text: "Arrange a meeting with my coffee distributors on 2031-06-10 at 3 PM for one hour.", objective_id: objectiveId })).body;
  const saved = (await post(base, "/api/odai/appointments", { ...ex.draft, date, location: "Marriott Singapore", objective_id: objectiveId, agenda: "New Coffee Product Discussion" })).body;
  assert.ok(saved.appointment?.id, "appointment saved: " + JSON.stringify(saved).slice(0, 200));
  return saved.appointment;
}

test("connections: WhatsApp not configured is reported honestly (no token exposure)", async () => {
  const j = await getj(P, "/api/odai/appointments/connections");
  assert.equal(j.whatsapp.mode, "not_configured");
  assert.equal(j.whatsapp.configured, false);
  assert.equal(j.calendar.configured, false);
  assert.ok(!JSON.stringify(j).includes("WHATSAPP_ACCESS_TOKEN="));
  const s = await getj(S, "/api/odai/appointments/connections");
  assert.equal(s.whatsapp.mode, "sandbox");
});

test("audience: consent + verified number + dedup; nothing invented", async () => {
  await seedDistributors(P);
  const j = (await post(P, "/api/odai/appointments/audience", { text: "Invite all my coffee distributors" })).body;
  assert.equal(j.count, 2, "2 eligible distributors (1 no-consent excluded, 1 duplicate phone deduped)");
  assert.ok(j.excluded.some((e) => /consent/.test(e.reason)));
  assert.ok(j.recipients.every((r) => r.consent && r.phone));
  const none = (await post(P, "/api/odai/appointments/audience", { text: "Invite all my business partners" })).body;
  assert.equal(none.count, 0);
  assert.ok(none.question, "asks who to invite instead of inventing recipients");
});

test("voice correction keeps the SAME appointment and invalidates approval", async () => {
  const oid = `OBJ-APPT-CORR-${run}`;
  const a = await makeAppointment(P, uniqDate(1), oid);
  const c = (await post(P, `/api/odai/appointments/${a.id}/correct`, { text: "Change the meeting to four in the afternoon." })).body;
  assert.equal(c.appointment.id, a.id);
  assert.equal(c.appointment.start, "16:00");
  assert.equal(c.appointment.end, "17:00", "duration preserved");
  assert.equal(c.approval_invalidated, true);
  const loc = (await post(P, `/api/odai/appointments/${a.id}/correct`, { text: "Change the location to my office." })).body;
  assert.equal(loc.appointment.location, "my office");
  /* /submit with the same objective routes to correction, not a new draft */
  const sub = (await post(P, "/api/odai/submit", { text: "Make the meeting two hours.", objective_id: oid, source: "voice" })).body;
  assert.equal(sub.appointment_correction, true);
  assert.equal(sub.appointment.id, a.id);
  assert.equal(sub.appointment.end, "18:00");
});

test("prepare + fingerprint-bound approval; dispatch HELD when adapter not configured", async () => {
  await seedDistributors(P);
  const a = await makeAppointment(P, uniqDate(2), `OBJ-APPT-PREP-${run}`);
  const prep = (await post(P, `/api/odai/appointments/${a.id}/prepare-invitations`, { audience_text: "Invite all my coffee distributors" })).body;
  assert.equal(prep.appointment.invitations.length, 2);
  assert.match(prep.summary, /Shall I proceed\?/);
  assert.ok(prep.fingerprint);
  assert.match(prep.appointment.invitations[0].text, /MEETING INVITATION/);
  assert.match(prep.appointment.invitations[0].text, /Dear Dist/);
  assert.ok(!prep.appointment.invitations[0].text.includes(prep.appointment.invitations[1].name), "no cross-recipient data");
  assert.equal(prep.availability.available, true);

  const denied = await post(P, `/api/odai/appointments/${a.id}/dispatch`, { approved: false });
  assert.equal(denied.status, 403, "no external action without explicit approval");

  /* material change → re-prepare → old fingerprint must be rejected */
  await post(P, `/api/odai/appointments/${a.id}/correct`, { text: "Change the location to Raffles Hotel." });
  const prep2 = (await post(P, `/api/odai/appointments/${a.id}/prepare-invitations`, {})).body;
  const stale = await post(P, `/api/odai/appointments/${a.id}/dispatch`, { approved: true, expected_fingerprint: prep.fingerprint });
  assert.equal(stale.status, 409, "stale approval rejected after material change");

  const ok = (await post(P, `/api/odai/appointments/${a.id}/dispatch`, { approved: true, expected_fingerprint: prep2.fingerprint })).body;
  assert.equal(ok.dispatch.held, 2);
  assert.equal(ok.dispatch.submitted, 0);
  assert.ok(ok.appointment.invitations.every((i) => i.status === "held_not_configured" && !i.message_id));
  assert.equal(ok.appointment.status, "Confirmed", "native record confirmed");
  assert.equal(ok.calendar.configured, false, "calendar sync honestly not configured");
  assert.match(ok.delivery_note, /Submission is not delivery/);
});

test("RogueAI Shield: agent audience expansion is blocked and recorded", async () => {
  const a = await makeAppointment(P, uniqDate(3), `OBJ-APPT-ROGUE-${run}`);
  await post(P, `/api/odai/appointments/${a.id}/prepare-invitations`, { audience_text: "Invite all my coffee distributors" });
  const before = (await getj(P, `/api/odai/appointments/${a.id}`)).appointment.recipients.length;
  const j = (await post(P, `/api/odai/appointments/${a.id}/expansion-test`, { agent_id: "rogue-marketing-agent" })).body;
  assert.equal(j.blocked, true);
  assert.ok(j.incident.recorded);
  const after = (await getj(P, `/api/odai/appointments/${a.id}`)).appointment;
  assert.equal(after.recipients.length, before, "audience unchanged");
  assert.ok(after.security_incidents.length >= 1);
  const actorDenied = await post(P, `/api/odai/appointments/${a.id}/dispatch`, { approved: true, actor: "rogue-marketing-agent" });
  assert.equal(actorDenied.status, 403, "non-owner cannot authorize dispatch");
});

test("RSVP: confirmed/declined tracked; attendance report from real records", async () => {
  const a = await makeAppointment(P, uniqDate(4), `OBJ-APPT-RSVP-${run}`);
  const prep = (await post(P, `/api/odai/appointments/${a.id}/prepare-invitations`, { audience_text: "Invite all my coffee distributors" })).body;
  const [r1, r2] = prep.appointment.invitations;
  await post(P, `/api/odai/appointments/${a.id}/rsvp`, { customer_id: r1.customer_id, response: "confirmed" });
  await post(P, `/api/odai/appointments/${a.id}/rsvp`, { customer_id: r2.customer_id, response: "declined" });
  const att = await getj(P, `/api/odai/appointments/${a.id}/attendance`);
  assert.equal(att.coming, 1);
  assert.equal(att.declined.length, 1);
  assert.equal(att.total_invited, 2);
  const bad = await post(P, `/api/odai/appointments/${a.id}/rsvp`, { customer_id: "CUS-unknown", response: "confirmed" });
  assert.equal(bad.status, 404, "RSVP only for invited recipients");
});

test("sandbox adapter: labeled SANDBOX message IDs, idempotent resend, never 'delivered'", async () => {
  await seedDistributors(S);
  const a = await makeAppointment(S, uniqDate(5), `OBJ-APPT-SBX-${run}`);
  const prep = (await post(S, `/api/odai/appointments/${a.id}/prepare-invitations`, { audience_text: "Invite all my coffee distributors" })).body;
  const ok = (await post(S, `/api/odai/appointments/${a.id}/dispatch`, { approved: true, expected_fingerprint: prep.fingerprint })).body;
  assert.equal(ok.whatsapp.mode, "sandbox");
  assert.equal(ok.dispatch.submitted, 2);
  assert.ok(ok.appointment.invitations.every((i) => i.status === "submitted_sandbox" && /^SANDBOX-wamid\./.test(i.message_id)));
  assert.ok(!ok.appointment.invitations.some((i) => i.status === "delivered"), "submission never claimed as delivery");
  /* resend: already-submitted recipients are skipped, not re-sent */
  const again = (await post(S, `/api/odai/appointments/${a.id}/dispatch`, { approved: true })).body;
  assert.ok(again.dispatch.results.every((r) => r.skipped), "no duplicate sends");
  const ids = again.appointment.invitations.map((i) => i.message_id);
  assert.deepEqual(ids, ok.appointment.invitations.map((i) => i.message_id), "message IDs preserved");
});