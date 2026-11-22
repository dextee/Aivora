import { useEffect, useState } from "react";
import { getAccessToken } from "./auth";
import type { AppointmentDraft } from "./TalkView";

const BOOKING_URL = "https://calendly.com/pingfaninsg";

type Conn = { provider: string; configured: boolean; mode: string; note?: string; calendly_booking_url?: string };
type Recipient = { customer_id: string; name: string; phone: string; language: string };
type Invitation = { customer_id: string; name: string; phone: string; language: string; text: string; status: string; message_id: string | null; rsvp?: string; error?: string | null };
type Appointment = {
  id: string; title: string; contact: string; phone: string; email: string; date: string; start: string; end: string;
  type: string; location: string; agenda: string; reminder: string; status: string; objective_id?: string | null;
  events?: string[]; recipients?: Recipient[]; invitations?: Invitation[];
  calendar_sync?: { configured?: boolean; ok?: boolean; event_id?: string; htmlLink?: string | null; error?: string };
};
type Availability = { available: boolean; conflicts: { title: string; start: string; end: string }[]; alternatives: { start: string; end: string }[]; google_calendar: { note: string }; attendee_availability: string };

const MicIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor" /><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
const Waveform = () => (
  <div className="appt-wave" aria-hidden="true">{Array.from({ length: 24 }).map((_, i) => <span key={i} style={{ animationDelay: `${(i % 8) * 0.12}s`, height: `${8 + ((i * 7) % 18)}px` }} />)}</div>
);

async function api(path: string, init?: RequestInit) {
  const token = getAccessToken();
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((j as { error?: string }).error || `HTTP ${res.status}`), j as object);
  return j;
}

export function AppointmentView({ onTalk, onSpeak, draft }: { onTalk(): void; onSpeak(): void; draft?: AppointmentDraft | null }) {
  const [items, setItems] = useState<Appointment[]>([]);
  const [conns, setConns] = useState<{ calendar: Conn; whatsapp: Conn } | null>(null);
  const [current, setCurrent] = useState<Appointment | null>(null);
  const [draftFields, setDraftFields] = useState<AppointmentDraft | null>(draft || null);
  const [question, setQuestion] = useState<string>(draft?.question || "");
  const [objectiveId, setObjectiveId] = useState<string>(draft?.objective_id || "");
  const [instruction, setInstruction] = useState("");
  const [audienceText, setAudienceText] = useState("");
  const [audience, setAudience] = useState<{ count: number; recipients: Recipient[]; excluded: { name?: string; reason: string }[]; question?: string | null } | null>(null);
  const [summary, setSummary] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [dispatch, setDispatch] = useState<{ submitted: number; held: number; failed: number; results: { name: string; status: string; message_id?: string | null }[] } | null>(null);
  const [attendance, setAttendance] = useState<{ confirmed: string[]; declined: string[]; no_reply: string[]; coming: number; total_invited: number } | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTyping, setShowTyping] = useState(false);

  async function refresh() {
    const j = await api(`/api/odai/appointments?_t=${Date.now()}`);
    setItems(j.appointments || []);
    const c = await api("/api/odai/appointments/connections");
    setConns(c);
  }
  useEffect(() => { void refresh().catch((e) => setError((e as Error).message)); }, []);

  /* Voice agent handoff returns a draft prop; adopt it. */
  useEffect(() => {
    if (draft) { setDraftFields(draft); setQuestion(draft.question || ""); setObjectiveId(draft.objective_id || ""); setCurrent(null); setDispatch(null); setAudience(null); }
  }, [draft]);

  async function extract(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const j = await api("/api/odai/appointments/extract", { method: "POST", body: JSON.stringify({ text, objective_id: objectiveId || undefined }) });
      setDraftFields(j.draft); setQuestion(j.question || ""); setObjectiveId(j.objective_id || "");
      setEvents((p) => [...p, "VOICE_RECEIVED", "TRANSCRIPTION_COMPLETED", "APPOINTMENT_OBJECTIVE_IDENTIFIED", "APPOINTMENT_FIELDS_EXTRACTED"]);
      setInstruction("");
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function saveDraft() {
    if (!draftFields || busy) return;
    setBusy(true); setError("");
    try {
      const j = await api("/api/odai/appointments", { method: "POST", body: JSON.stringify({ ...draftFields, objective_id: objectiveId || undefined, source_text: draftFields.agenda }) });
      setCurrent(j.appointment); setDraftFields(null); setQuestion("");
      setEvents((p) => [...p, ...(j.appointment.events || [])]);
      await refresh();
    } catch (e) {
      const err = e as Error & { alternatives?: { start: string; end: string }[] };
      setError(err.message + (err.alternatives?.length ? ` Available: ${err.alternatives.map((a) => a.start).join(", ")}. Say "change the meeting to ${err.alternatives[0].start}".` : ""));
    }
    setBusy(false);
  }

  async function correct(text: string) {
    if (!current || !text.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const j = await api(`/api/odai/appointments/${encodeURIComponent(current.id)}/correct`, { method: "POST", body: JSON.stringify({ text }) });
      setCurrent(j.appointment); setSummary(""); setFingerprint(""); setDispatch(null);
      setEvents((p) => [...p, `Voice correction: ${(j.changed || []).join("; ") || "no material change"}`]);
      setInstruction(""); await refresh();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function resolveAudience() {
    if (!audienceText.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const j = await api("/api/odai/appointments/audience", { method: "POST", body: JSON.stringify({ text: audienceText }) });
      setAudience(j);
      setEvents((p) => [...p, `TARGET_AUDIENCE_IDENTIFIED (${j.count} authorized recipients)`]);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function prepare() {
    if (!current || busy) return;
    setBusy(true); setError("");
    try {
      const j = await api(`/api/odai/appointments/${encodeURIComponent(current.id)}/prepare-invitations`, { method: "POST", body: JSON.stringify({ audience_text: audienceText || undefined }) });
      setCurrent(j.appointment); setSummary(j.summary); setFingerprint(j.fingerprint); setAvailability(j.availability);
      if (j.audience) setAudience(j.audience);
      setEvents((p) => [...p, "RECIPIENTS_VALIDATED", "GOOGLE_CALENDAR_AVAILABILITY_CHECKED", "WHATSAPP_INVITATIONS_GENERATED"]);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function proceed() {
    if (!current || busy) return;
    setBusy(true); setError("");
    try {
      const j = await api(`/api/odai/appointments/${encodeURIComponent(current.id)}/dispatch`, { method: "POST", body: JSON.stringify({ approved: true, expected_fingerprint: fingerprint, actor: "owner" }) });
      setCurrent(j.appointment); setDispatch(j.dispatch);
      setEvents((p) => [...p, "VOICE_CONFIRMATION_RECEIVED", "ROGUEAI_POLICY_EVALUATED", ...(j.appointment.events || []).slice(-4)]);
      const att = await api(`/api/odai/appointments/${encodeURIComponent(current.id)}/attendance`);
      setAttendance(att); await refresh();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function rsvp(customerId: string, response: "confirmed" | "declined") {
    if (!current) return;
    try {
      const j = await api(`/api/odai/appointments/${encodeURIComponent(current.id)}/rsvp`, { method: "POST", body: JSON.stringify({ customer_id: customerId, response }) });
      setCurrent(j.appointment);
      setAttendance(await api(`/api/odai/appointments/${encodeURIComponent(current.id)}/attendance`));
    } catch (e) { setError((e as Error).message); }
  }

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const upcoming = items.filter((a) => a.date >= today && a.status !== "Cancelled").sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const waMode = conns?.whatsapp?.mode || "not_configured";
  const preview = current?.invitations?.[0] || null;

  const connCard = (label: string, c: Conn | undefined, icon: string) => (
    <div className="appt-conn">
      <div className="appt-conn-icon">{icon}</div>
      <b>{label}</b>
      <small>{c?.configured ? (c.mode === "live" ? "Connected · live" : "Connected · sandbox (labeled)") : "Connection required"}</small>
    </div>
  );

  return (
    <main className="view inbox-view">
      <h1>📅 My Appointment</h1>
      {error && <p role="alert">{error}</p>}

      <div className="appt-conns">
        {connCard("Google Calendar", conns?.calendar, "🗓️")}
        {connCard("WhatsApp Business", conns?.whatsapp, "💬")}
      </div>
      {conns && !conns.calendar.configured && <p className="appt-hint">Google Calendar: set <code>GOOGLE_CALENDAR_ACCESS_TOKEN</code> (server env) for live sync. The .ics export and <a href={BOOKING_URL} target="_blank" rel="noopener noreferrer">Calendly</a> work now.</p>}
      {conns && !conns.whatsapp.configured && <p className="appt-hint">WhatsApp: invitations are generated and <b>held</b> until the server adapter is configured (<code>WHATSAPP_ACCESS_TOKEN</code> + <code>WHATSAPP_PHONE_NUMBER_ID</code>, or <code>WHATSAPP_SANDBOX=1</code> for a labeled test). Nothing is sent to real recipients without it.</p>}

      <section className="inbox-card appt-speak">
        <h2>Just Speak to AIVORA</h2>
        <button className="big-mic" aria-label="Speak to AIVORA — start Qwen audio voice agent" onClick={onSpeak} style={{ margin: "0 auto" }}><MicIcon /></button>
        <p>Tap to preview voice interaction</p>
        <Waveform />
        <p className="appt-hint">No typing or manual form filling required.</p>
        <button className="appt-typing-toggle" onClick={() => setShowTyping((s) => !s)}>{showTyping ? "Hide text fallback" : "Prefer typing? (optional)"}</button>
        {showTyping && <>
          <textarea aria-label="Appointment instruction" value={instruction} placeholder={current ? "Change the meeting to four in the afternoon." : "Arrange a meeting with my coffee distributors on Friday at 3 PM for one hour at Marriott Singapore."} onChange={(e) => setInstruction(e.target.value)} style={{ width: "100%", minHeight: 56 }} />
          <button className="inbox-primary" disabled={busy || !instruction.trim()} onClick={() => void (current ? correct(instruction) : extract(instruction))}>{busy ? "Working…" : current ? "Apply correction" : "Extract appointment →"}</button>
        </>}
      </section>

      {draftFields && (
        <section className="inbox-card">
          <h2>Appointment captured — review by voice</h2>
          {question && <p role="alert">One detail needed: {question}</p>}
          <div className="appt-fields">
            <p><b>{draftFields.title || "…"}</b></p>
            <p>👥 {draftFields.contact || "—"}{draftFields.phone ? ` · ${draftFields.phone}` : ""}</p>
            <p>📅 {draftFields.date || "—"} · 🕒 {draftFields.start || "—"}–{draftFields.end || "—"} (Asia/Singapore)</p>
            <p>📍 {draftFields.location || "venue to be confirmed"} · {draftFields.type}</p>
            <p>🔔 {draftFields.reminder}</p>
          </div>
          <p className="appt-hint">Correct anything by speaking (e.g. “change the meeting to four in the afternoon”). Fields fill automatically — no manual form.</p>
          <button className="inbox-primary" disabled={busy || !draftFields.date || !draftFields.start} onClick={() => void saveDraft()}>{busy ? "Saving…" : "Save appointment"}</button>
          <button onClick={() => { setDraftFields(null); setQuestion(""); }}>Discard</button>
        </section>
      )}

      {current && (
        <section className="inbox-card">
          <h2>{current.title} <small>{current.status}</small></h2>
          <p>📅 {current.date} · 🕒 {current.start}–{current.end} · 📍 {current.location || "venue to be confirmed"}</p>
          <p>👥 {current.contact} · 🔔 {current.reminder}</p>

          {!summary && <>
            <h3>Who should be invited?</h3>
            <input aria-label="Target audience" value={audienceText} placeholder="Invite all my coffee distributors" onChange={(e) => setAudienceText(e.target.value)} style={{ width: "100%" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button disabled={busy || !audienceText.trim()} onClick={() => void resolveAudience()}>Find recipients</button>
              <button className="inbox-primary" disabled={busy} onClick={() => void prepare()}>{busy ? "Preparing…" : "Prepare invitations →"}</button>
            </div>
            {audience && <p>{audience.count} authorized recipient{audience.count === 1 ? "" : "s"}{audience.excluded?.length ? ` · ${audience.excluded.length} excluded (consent/number missing)` : ""}{audience.question ? ` — ${audience.question}` : ""}</p>}
          </>}

          {summary && !dispatch && <>
            <h3>Voice confirmation</h3>
            <p className="appt-summary">“{summary}”</p>
            {availability && !availability.available && <p role="alert">Conflict: {availability.conflicts.map((c) => `${c.title} ${c.start}–${c.end}`).join("; ")}. Alternatives: {availability.alternatives.map((a) => a.start).join(", ") || "none"}.</p>}
            {availability && <p className="appt-hint">{availability.google_calendar.note} {availability.attendee_availability}.</p>}
            <button className="inbox-primary" disabled={busy || (availability ? !availability.available : false)} onClick={() => void proceed()}>{busy ? "Working…" : "Yes, proceed ✓"}</button>
            <button onClick={() => { setSummary(""); setFingerprint(""); }}>Not yet</button>
          </>}

          {preview && (
            <div className="wa-preview">
              <div className="wa-head">💬 AIVORA Coffee <small>Business account · {waMode === "live" ? "Live" : waMode === "sandbox" ? "Sandbox preview" : "Preview (held)"}</small></div>
              <div className="wa-bubble">
                {preview.text.split("\n").map((line, i) => line ? <p key={i}>{line}</p> : <br key={i} />)}
                <div className="wa-actions">
                  <button onClick={() => void rsvp(preview.customer_id, "confirmed")}>Confirm Attendance</button>
                  <a href={`/api/odai/appointments/${encodeURIComponent(current.id)}/ics`} download>Add to Calendar</a>
                </div>
                <small className="wa-foot">{waMode === "sandbox" ? "Sandbox invitation — not sent to a real recipient" : waMode === "live" ? "Sent via WhatsApp Business (submission ≠ delivery)" : "Example invitation — held until the adapter is connected"}</small>
              </div>
            </div>
          )}

          {dispatch && (
            <div>
              <h3>Dispatch result</h3>
              <p>{dispatch.submitted} submitted ({waMode}) · {dispatch.held} held · {dispatch.failed} failed. Submission is not delivery.</p>
              {dispatch.results.map((r) => <p key={r.name}>• {r.name}: {r.status}{r.message_id ? ` (${r.message_id})` : ""}</p>)}
              {current.calendar_sync && <p>{current.calendar_sync.configured && current.calendar_sync.ok ? `✓ Google Calendar event ${current.calendar_sync.event_id}` : "Google Calendar not connected — native record confirmed; use Add to Calendar (.ics) above."}</p>}
            </div>
          )}

          {attendance && attendance.total_invited > 0 && (
            <p>RSVP: {attendance.coming}/{attendance.total_invited} coming · confirmed: {attendance.confirmed.join(", ") || "none"} · no reply: {attendance.no_reply.join(", ") || "none"}{attendance.declined.length ? ` · declined: ${attendance.declined.join(", ")}` : ""}</p>
          )}
        </section>
      )}

      {events.length > 0 && (
        <section className="inbox-card">
          <h2>Appointment Execution</h2>
          <div className="appt-exec">{events.map((e, i) => <p key={i}>✓ {e}</p>)}</div>
        </section>
      )}

      <section className="inbox-card">
        <h2>Upcoming appointments</h2>
        {upcoming.length === 0 && <p>No upcoming appointments yet. Speak to create one.</p>}
        {upcoming.map((a) => (
          <div key={a.id} className="appt-upcoming">
            <p><b>{a.title}</b> <small>{a.status}</small></p>
            <p>{a.date} · {a.start}–{a.end} · {a.contact}{a.invitations?.length ? ` · ${a.invitations.filter((i) => i.rsvp === "confirmed").length}/${a.invitations.length} confirmed` : ""}</p>
            <button onClick={() => { setCurrent(a); setSummary(""); setDispatch(null); setAudience(null); setEvents(a.events || []); }}>Manage by voice</button>
            {a.status === "Confirmed" && <a href={`/api/odai/appointments/${encodeURIComponent(a.id)}/ics`} download> .ics</a>}
          </div>
        ))}
        <p className="appt-hint"><button onClick={onTalk}>Open Talk to AIVORA</button> — the same voice agent handles appointments, corrections and reminders.</p>
      </section>
    </main>
  );
}