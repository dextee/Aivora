import { useEffect, useState } from "react";
import { getAccessToken } from "./auth";

type Message = { notification_id: string; agent_id: string; title: string; message: string; category: string; severity: string; created_at: string; read_status: string; is_sandbox: boolean; approval_status: string | null; deep_link: string | null; evidence_references: { event_id: string; ts: string; kind: string; decision: string | null; beat: number | null }[] };
type Inbox = { counts: { unread: number; approvals: number; security: number; insights: number }; messages: Message[]; summary: string; mode: string };
type Email = { message_id: string; from_name: string; from_email: string; subject: string; body: string; snippet: string; category: string; received_at: string; is_demo: boolean; quarantined?: boolean };
type Draft = { draft_id: string; to: string; subject: string; body: string; version: number; attachments: { document_id: string; type: string; content_hash: string; total: number }[]; amount: number | null; currency: string };
type Doc = { document_id: string; type: string; customer: string; items: { name: string; qty: number; unit_price: number; line_total: number }[]; total: number; currency: string; content_hash: string };
type Gmail = { mode: string; configured: boolean; note: string };

const MicIcon = () => (<svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor" /><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>);
const Waveform = () => (<div className="appt-wave" aria-hidden="true">{Array.from({ length: 24 }).map((_, i) => <span key={i} style={{ animationDelay: `${(i % 8) * 0.12}s`, height: `${8 + ((i * 7) % 18)}px` }} />)}</div>);

async function api(path: string, init?: RequestInit) {
  const token = getAccessToken();
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((j as { error?: string }).error || `HTTP ${res.status}`), j as object);
  return j;
}

export function InboxView({ onOpen, onSpeak }: { onOpen(view: string): void; onSpeak?: () => void }) {
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("ALL");
  const [q, setQ] = useState("");
  const [brief, setBrief] = useState(false);
  const [busy, setBusy] = useState(false);

  const [gmail, setGmail] = useState<Gmail | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [active, setActive] = useState<Email | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [spoken, setSpoken] = useState("");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [confirmSummary, setConfirmSummary] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [security, setSecurity] = useState("");
  const [dispatchResult, setDispatchResult] = useState("");
  const [health, setHealth] = useState<{ native_inbox: string; mode: string; dimensions?: Record<string, string> } | null>(null);

  async function request(path: string, init?: RequestInit) {
    const token = getAccessToken();
    const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    const j = await res.json(); if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`); return j as Inbox;
  }
  const params = () => new URLSearchParams({ category, q, _t: String(Date.now()) });
  async function refreshNotifications() { try { setData(await request(`/api/odai/inbox?${params()}`)); } catch (e) { setError((e as Error).message); } }
  async function refreshMail() {
    try {
      const j = await api(`/api/odai/mail?_t=${Date.now()}`);
      setGmail(j.gmail); setEmails(j.emails || []);
      if (j.context?.active_message_id) setActive((j.emails || []).find((e: Email) => e.message_id === j.context.active_message_id) || null);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void refreshNotifications(); void refreshMail(); api("/api/odai/inbox/health").then(setHealth).catch(() => setHealth(null)); }, [category, q]);

  function log(line: string) { setTimeline((t) => [...t.slice(-40), line]); }
  async function run(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true); setError(""); setCommand("");
    try {
      const j = await api("/api/odai/mail/handle", { method: "POST", body: JSON.stringify({ text }) });
      if (j.spoken) setSpoken(j.spoken);
      log(`VOICE_INPUT_RECEIVED -> ${j.kind || "handled"}`);
      if (j.kind === "briefing") { setCounts(j.counts); log("VOICE_SUMMARY_GENERATED"); }
      if (j.email) { setActive(j.email); log("ACTIVE_EMAIL_CONTEXT_RESOLVED"); }
      if (j.draft) { setDraft(j.draft); log(`EMAIL_DRAFT_GENERATED v${j.draft.version}`); }
      if (j.document) { setDoc(j.document); log(`DOCUMENT_GENERATED ${j.document.type} ${j.document.currency} ${j.document.total}`); }
      if (j.kind === "confirm_prompt") { setConfirmSummary(j.summary); setFingerprint(j.fingerprint); log("VOICE_APPROVAL_REQUESTED"); }
      if (j.kind === "dispatch") { setDispatchResult(j.spoken); setConfirmSummary(""); log(`GMAIL_MESSAGE_SUBMITTED ${j.result?.status}`); }
      if (j.kind === "appointment") { log("BUSINESS_OBJECTIVE_CREATED (appointment)"); setSpoken(j.question ? `Appointment draft ready - ${j.question}` : "Appointment draft ready - open Appointment to review."); }
      await refreshMail(); await refreshNotifications();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  async function seed() { setBusy(true); try { await api("/api/odai/mail/seed", { method: "POST" }); await refreshMail(); setSpoken("Demo mailbox loaded (synthetic contacts, clearly labeled)."); } catch (e) { setError((e as Error).message); } setBusy(false); }
  async function scan() {
    if (!active) return; setBusy(true);
    try { const j = await api("/api/odai/mail/scan", { method: "POST", body: JSON.stringify({ message_id: active.message_id }) }); setSecurity(j.spoken); log(j.malicious ? "ROGUEAI_POLICY_EVALUATED - BLOCK" : "ROGUEAI_POLICY_EVALUATED - clean"); await refreshMail(); await refreshNotifications(); }
    catch (e) { setError((e as Error).message); } setBusy(false);
  }
  async function dispatch() {
    setBusy(true); setError("");
    try { const j = await api("/api/odai/mail/dispatch", { method: "POST", body: JSON.stringify({ approved: true, expected_fingerprint: fingerprint, actor: "owner" }) }); setDispatchResult(j.spoken); setConfirmSummary(""); setDraft(j.draft); log(`GMAIL_MESSAGE_SUBMITTED ${j.result?.status}`); await refreshNotifications(); }
    catch (e) { setError((e as Error).message); } setBusy(false);
  }
  async function update(id: string, action: string) { setBusy(true); try { await request(`/api/odai/inbox/${id}?_t=${Date.now()}`, { method: "POST", body: JSON.stringify({ action }) }); await refreshNotifications(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }

  return <main className="view inbox-view">
    <div className="inbox-heading"><div><h1>My Inbox</h1><p>Your voice-operated AI secretary for email and notifications.</p></div><button onClick={() => { void refreshNotifications(); void refreshMail(); }}>Refresh</button></div>
    {health && <p className="inbox-health" data-status={health.native_inbox}>Inbox readiness: <strong>{health.native_inbox}</strong> · mode {health.mode}{health.native_inbox !== "READY" && health.dimensions ? " · " + Object.entries(health.dimensions).filter(([, v]) => v !== "READY").map(([k, v]) => `${k}: ${v}`).join("; ") : ""}</p>}
    {data && data.messages.length === 0 && <p className="inbox-empty">No notifications yet. Real business events will appear here — nothing is pre-filled.</p>}
    {error && <p role="alert" className="inbox-card">{error}</p>}

    <div className="appt-conns"><div className="appt-conn"><div className="appt-conn-icon">✉️</div><b>Gmail</b><small>{gmail?.configured ? (gmail.mode === "live" ? "Connected · live" : "Connected · sandbox (labeled)") : "Connection required"}</small></div></div>
    {gmail && !gmail.configured && <p className="appt-hint">{gmail.note}</p>}

    <section className="inbox-card appt-speak">
      <h2>Just Speak to AIVORA</h2>
      {onSpeak && <button className="big-mic" aria-label="Speak to Inbox - start Qwen audio voice agent" onClick={onSpeak} style={{ margin: "0 auto" }}><MicIcon /></button>}
      <Waveform />
      <p className="appt-hint">Say "read my emails", "reply to this customer", "prepare a quotation", or "send the invoice". No typing required.</p>
      {spoken && <p className="appt-summary" aria-live="polite">🔊 {spoken}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input aria-label="Voice command (text fallback)" value={command} placeholder="read my emails" onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(command); }} style={{ flex: 1 }} />
        <button className="inbox-primary" disabled={busy || !command.trim()} onClick={() => void run(command)}>{busy ? "…" : "Say it"}</button>
      </div>
      <div className="inbox-actions" style={{ marginTop: 8 }}>
        <button disabled={busy} onClick={() => void run("read my emails")}>Read my emails</button>
        <button disabled={busy} onClick={() => void seed()}>Load demo mailbox</button>
      </div>
      {counts && <div className="inbox-counts">{Object.entries(counts).map(([c, n]) => <button key={c} onClick={() => void run("read the first email")}><strong>{n}</strong><span>{c.replace(/_/g, " ")}</span></button>)}</div>}
    </section>

    {active && (
      <section className="inbox-card">
        <div className="inbox-heading"><h2>Current email</h2><span>{active.category.replace(/_/g, " ")}{active.is_demo ? " · demo" : ""}</span></div>
        <p><b>From:</b> {active.from_name} &lt;{active.from_email}&gt;</p>
        <p><b>Subject:</b> {active.subject}</p>
        <p>{active.body}</p>
        {active.quarantined && <p role="alert">⚠️ Quarantined as untrusted - grants no execution authority.</p>}
        <div className="inbox-actions">
          <button disabled={busy} onClick={() => void run("go back")}>◀ Back</button>
          <button disabled={busy} onClick={() => void run("next email")}>Next ▶</button>
          <button disabled={busy} onClick={() => void run("read that again")}>Read again</button>
          <button disabled={busy} onClick={() => void run("summarize it")}>Summarize</button>
          <button disabled={busy} onClick={() => void run("who sent it")}>Who sent it?</button>
          <button disabled={busy} onClick={() => void run("translate it into Chinese")}>中文</button>
          <button disabled={busy} onClick={() => void scan()}>Security scan</button>
        </div>
        <div className="inbox-actions" style={{ marginTop: 6 }}>
          <button className="inbox-primary" disabled={busy} onClick={() => void run("reply to this customer and tell him our prices")}>Reply with prices</button>
          <button disabled={busy} onClick={() => void run("prepare a quotation for him")}>Quotation</button>
          <button disabled={busy} onClick={() => void run("send him the invoice")}>Invoice</button>
          <button disabled={busy} onClick={() => void run("arrange a meeting with this customer next Friday")}>Arrange meeting</button>
        </div>
      </section>
    )}

    {security && <section className="inbox-card"><h2>Security</h2><p role="alert">{security}</p></section>}

    {draft && (
      <section className="inbox-card">
        <h2>AI reply preview <small>v{draft.version}</small></h2>
        <p><b>To:</b> {draft.to} · <b>Subject:</b> {draft.subject}</p>
        <pre className="mail-body">{draft.body}</pre>
        <div className="inbox-actions">
          <button disabled={busy} onClick={() => void run("make it more professional")}>Professional</button>
          <button disabled={busy} onClick={() => void run("make it friendlier")}>Friendlier</button>
          <button disabled={busy} onClick={() => void run("make it shorter")}>Shorter</button>
          <button disabled={busy} onClick={() => void run("translate it to Mandarin")}>Mandarin</button>
          <button disabled={busy} onClick={() => void run("add our delivery information")}>+ Delivery</button>
        </div>
        {draft.attachments?.length > 0 && <div className="mail-attach">📎 {draft.attachments.map((a) => `${a.type} · ${draft.currency} ${a.total} · hash ${a.content_hash.slice(0, 10)}`).join("; ")}</div>}
        {!confirmSummary
          ? <button className="inbox-primary" disabled={busy} onClick={() => void run("send it")}>Send →</button>
          : <div><p className="appt-summary">🔊 {confirmSummary}</p><button className="inbox-primary" disabled={busy} onClick={() => void dispatch()}>Yes, proceed ✓</button><button onClick={() => setConfirmSummary("")}>Not yet</button></div>}
        {dispatchResult && <p aria-live="polite">{dispatchResult}</p>}
      </section>
    )}

    {doc && (
      <section className="inbox-card">
        <h2>{doc.type} · {doc.customer}</h2>
        <table className="mail-doc"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
          <tbody>{doc.items.map((l) => <tr key={l.name}><td>{l.name}</td><td>{l.qty}</td><td>{l.unit_price.toFixed(2)}</td><td>{l.line_total.toFixed(2)}</td></tr>)}</tbody></table>
        <p><b>Total: {doc.currency} {doc.total.toFixed(2)}</b> · hash {doc.content_hash.slice(0, 12)}</p>
      </section>
    )}

    {timeline.length > 0 && <section className="inbox-card"><h2>Execution timeline</h2><div className="appt-exec">{timeline.map((e, i) => <p key={i}>✓ {e}</p>)}</div></section>}

    {data && <>
      <section className="inbox-card"><h2>Business Summary</h2><div className="inbox-counts">{([['Approvals', data.counts.approvals], ['Security', data.counts.security], ['Insights', data.counts.insights]] as const).map(([label, n]) => <button key={label} onClick={() => setCategory(label.toUpperCase())}><strong>{n}</strong><span>{label}</span></button>)}</div><button className="inbox-primary" onClick={() => setBrief(!brief)}>Brief Me on My Business</button>{brief && <div aria-live="polite"><p>{data.summary}</p></div>}</section>
      <nav className="inbox-pills" aria-label="Inbox categories">{['ALL', 'APPROVALS', 'SECURITY', 'INSIGHTS', 'UPDATES', 'RECOVERY'].map((c) => <button key={c} aria-pressed={c === category} onClick={() => setCategory(c)}>{c}</button>)}</nav>
      <label>Search messages<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search safe previews" /></label>
      <div className="inbox-heading"><h2>Latest Notifications</h2><button disabled={busy} onClick={() => void update("all", "read_all")}>Mark all as read</button></div>
      {!data.messages.length && <section className="inbox-card"><h3>No messages in this category</h3><p>Notifications appear only when supported backend events occur.</p></section>}
      {data.messages.map((m) => <article className="inbox-card" key={m.notification_id}><div className="inbox-heading"><span className="inbox-agent">AI · {m.agent_id}</span><span>{m.read_status}</span></div><h3>{m.title}</h3><p>{m.message}</p><div className="inbox-meta"><span>{m.category} · {m.severity}</span><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString()}</time></div>{m.is_sandbox && <p>Sandbox / test execution</p>}<div className="inbox-actions"><button disabled={busy || m.read_status === "read"} onClick={() => void update(m.notification_id, "read")}>Mark as read</button><button disabled={busy} onClick={() => void update(m.notification_id, "archive")}>Archive</button>{m.deep_link && <button onClick={() => onOpen(m.deep_link!)}>Open {m.deep_link === "myshop" ? "My Shop" : m.deep_link === "security" ? "SHIELD" : "Execution"}</button>}</div></article>)}
    </>}
    <button className="inbox-primary" onClick={() => onOpen("talk")}>Use existing voice and text entry</button>
  </main>;
}