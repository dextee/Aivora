import { useEffect, useState } from "react";

/* My Goals — Augmented AI Report for MAIN-FIX. Uses MAIN's shapes: GET /objectives returns an array;
 * the report is salesReport (GET /objectives/:id/report); governed boost + organic-only via the
 * added engine behaviours. Honest: sales show "Waiting for sales data"; boost is blocked, S$0. */
interface Obj { objective_id: string; statement: string; state: string; criterion: any; }
interface Rep { objective_id: string; state: string; goal: any; sales: any; briefing: string; constraints: any; sales_source?: { note: string }; }
interface Detail { objective_id: string; state: string; progress: string; tasks: any[]; gates: any[]; }

export function GoalsView() {
  const [list, setList] = useState<Obj[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [rep, setRep] = useState<Rep | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [boostAmt, setBoostAmt] = useState("20");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() { try { const j = await (await fetch(`/api/odai/objectives?_t=${Date.now()}`)).json(); setList(Array.isArray(j) ? j : (j.objectives || [])); } catch { /* none */ } }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!sel) { setRep(null); setDetail(null); return; } (async () => { try { const [r, d] = await Promise.all([fetch(`/api/odai/objectives/${sel}/report?_t=${Date.now()}`), fetch(`/api/odai/objectives/${sel}?_t=${Date.now()}`)]); setRep(await r.json()); setDetail(await d.json()); } catch { /* ignore */ } })(); }, [sel]);

  async function createGoal() { if (!text.trim() || busy) return; setBusy(true); setMsg(null);
    try { const j = await (await fetch(`/api/odai/submit?_t=${Date.now()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, request_id: `goal:${Date.now()}`, source: "typed" }) })).json();
      if (j.error) setMsg(j.error); else if (j.objective_id) { setSel(j.objective_id); await refresh(); }
    } catch { setMsg("engine unreachable"); } finally { setText(""); setBusy(false); } }

  async function boost() { if (!sel) return; setBusy(true);
    try { const j = await (await fetch(`/api/odai/objectives/${sel}/boost`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: Number(boostAmt) }) })).json(); setMsg(j.message || (j.error || "boosted")); } finally { setBusy(false); } }
  async function organic() { if (!sel) return; setBusy(true);
    try { await fetch(`/api/odai/objectives/${sel}/constraint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organic_only: true }) }); const r = await (await fetch(`/api/odai/objectives/${sel}/report?_t=${Date.now()}`)).json(); setRep(r); setMsg("Organic-only set on this goal."); } finally { setBusy(false); } }

  const card: React.CSSProperties = { border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 14 };
  return (
    <div className="view" style={{ padding: 16, maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>🎯 My Goals</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="q4input" style={{ flex: 1 }} placeholder="e.g. Sell 100 cups via FNYGlobal catalog" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createGoal(); }} />
          <button className="q4send" onClick={() => void createGoal()} disabled={busy || !text.trim()}>Save goal</button>
        </div>
        {msg && <p style={{ fontSize: 12, color: "#3fb37f", margin: "8px 0 0" }}>{msg}</p>}
      </section>

      <section style={card}>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Goals ({list.length})</h4>
        {list.length === 0 && <p style={{ fontSize: 12, color: "var(--ink2)" }}>No goals yet.</p>}
        {list.map((o) => (<div key={o.objective_id} onClick={() => setSel(o.objective_id)} style={{ cursor: "pointer", padding: "6px 8px", borderRadius: 8, background: sel === o.objective_id ? "rgba(63,179,127,.12)" : "transparent", fontSize: 13 }}>{o.objective_id} · {o.state} · {String(o.statement).slice(0, 40)}</div>))}
      </section>

      {rep && (
        <section style={card}>
          <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>📊 Augmented AI Report</h4>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
            <span>Target: <b>{rep.goal?.target_cups ?? "—"}</b></span><span>Days left: <b>{rep.goal?.days_left ?? "—"}</b></span>
            <span>Sold: <b>{rep.sales?.cups_sold ?? "waiting"}</b></span><span>Progress: <b>{rep.sales?.progress_pct != null ? rep.sales.progress_pct + "%" : "—"}</b></span>
          </div>
          <p style={{ fontSize: 12.5, margin: "8px 0 0" }}>🗣 {rep.briefing}</p>
          <p style={{ fontSize: 11, color: "var(--ink2)", margin: "6px 0 0" }}>{rep.sales_source?.note}</p>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <input className="q4input" style={{ width: 70 }} value={boostAmt} onChange={(e) => setBoostAmt(e.target.value)} />
            <button className="q4send" style={{ padding: "6px 12px" }} onClick={() => void boost()} disabled={busy}>Request boost</button>
            <button className="q4send" style={{ padding: "6px 12px", opacity: .85 }} onClick={() => void organic()} disabled={busy}>Set organic-only</button>
          </div>
        </section>
      )}

      {detail && detail.tasks && (
        <section style={card}>
          <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Show what AIVORA did</h4>
          <p style={{ fontSize: 12, color: "var(--ink2)", margin: "0 0 6px" }}>{detail.progress}</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{detail.tasks.map((t: any) => <li key={t.id}>{t.id} — {t.state}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
