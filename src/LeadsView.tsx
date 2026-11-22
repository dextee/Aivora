import { useEffect, useState } from "react";

/* Leads (Customers & Contacts) — minimal working slice. Captures enquiries and drafts a follow-up.
 * Outbound messaging is NEVER in this build: drafts are reviewable only, sending is blocked at the gate. */
interface Lead { id: string; name: string; channel: string; message: string; captured_at: string; status: string; followup_draft: string | null; comms: string; }

export function LeadsView() {
  const [rows, setRows] = useState<Lead[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try { const j = await (await fetch(`/api/odai/leads?_t=${Date.now()}`)).json(); setRows(j.leads || []); setErr(null); }
    catch { setErr("Can't reach the leads store."); }
  }
  useEffect(() => { void refresh(); }, []);

  async function add() {
    if (!msg.trim() || busy) return;
    setBusy(true);
    try { await fetch(`/api/odai/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name || "Customer", channel: "whatsapp", message: msg, request_id: `lead:${Date.now()}` }) }); await refresh(); setName(""); setMsg(""); }
    finally { setBusy(false); }
  }
  async function draft(id: string) {
    setBusy(true);
    try { await fetch(`/api/odai/leads/${id}/followup`, { method: "POST" }); await refresh(); }
    finally { setBusy(false); }
  }

  const card: React.CSSProperties = { border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 14 };
  return (
    <div className="view" style={{ padding: 16, maxWidth: 620, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: "var(--ink2)", margin: 0 }}>Main action: <b>Follow up with a lead</b></p>
      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Capture an enquiry</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input className="q4input" placeholder="Customer name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="q4input" rows={2} placeholder="Their message, e.g. “Can I get 20 boxes of kopi O?”" value={msg} onChange={(e) => setMsg(e.target.value)} />
          <button className="q4send" style={{ alignSelf: "flex-start", padding: "8px 14px" }} onClick={() => void add()} disabled={busy || !msg.trim()}>Save lead</button>
        </div>
      </section>
      {err && <p style={{ color: "#e0655f", fontSize: 12 }}>{err}</p>}
      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Leads ({rows.length})</h3>
        {rows.length === 0 && <p style={{ fontSize: 12, color: "var(--ink2)" }}>No enquiries yet.</p>}
        {rows.map((l) => (
          <div key={l.id} style={{ borderTop: "1px solid var(--line,#2a2f45)", padding: "10px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <b style={{ fontSize: 13 }}>{l.name}</b><small style={{ color: "var(--ink2)" }}>{l.channel} · {new Date(l.captured_at).toLocaleString()}</small>
            </div>
            <p style={{ fontSize: 12.5, margin: "4px 0" }}>“{l.message}”</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: l.status === "followup_drafted" ? "#3fb37f" : "var(--ink2)" }}>{l.status}</span>
              {l.status !== "followup_drafted" && <button className="q4send" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => void draft(l.id)} disabled={busy}>Draft follow-up</button>}
            </div>
            {l.followup_draft && (
              <div style={{ marginTop: 8, background: "rgba(255,255,255,.04)", border: "1px solid var(--line,#2a2f45)", borderRadius: 10, padding: 10 }}>
                <p style={{ fontSize: 12, margin: "0 0 6px" }}>{l.followup_draft}</p>
                <small style={{ color: "#e0a23a", fontSize: 11 }}>🔒 Draft only — sending requires owner approval; outbound comms are disabled (NEVER) in this build.</small>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
