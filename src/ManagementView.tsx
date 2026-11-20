import { useCallback, useEffect, useRef, useState } from "react";
import { loadConfig } from "./lib";

/* MANAGEMENT MODE — green/purple on black per approved screen.
 * QwenWork AI Brain hub + 6 specialists + live AI Execution Trace + governed
 * human spend gate. Shows explainable decision summaries only (never CoT). */
type Receipt = { runId: string; beat: number; id: string; role: string; summary: string; decision?: string; awaiting?: boolean; demo_mode: string };
type MView = { mission: string; specialists: string[]; trace: { ts: string; runId?: string; beat?: number; actor?: string; kind: string; decision?: string; note?: string }[]; receipts: Receipt[]; data_mode: string };

const ROLE_ICON: Record<string, string> = { research: "🔍", catalog: "🗄️", website: "🌐", marketing: "📢", watch: "🛡️", report: "📊", orchestrator: "🧠", "human-gate": "👤", "catalog+website": "🌐" };
const PHASE: Record<number, string> = { 1: "Understand", 2: "Plan", 3: "Assign", 4: "Execute", 5: "Approval", 6: "Execute", 7: "Coordinate", 8: "Execute", 9: "Verify", 10: "Report" };

export function ManagementView() {
  const [v, setV] = useState<MView | null>(null);
  const [obj, setObj] = useState("Sell FNYGlobal wellness products to 100 customers");
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState(150);
  const [err, setErr] = useState<string | null>(null);
  const t0 = useRef(0);

  const refresh = useCallback(async () => {
    const c = loadConfig();
    const r = await fetch(`/api/odai/view?mode=management&_t=${Date.now()}`, { headers: c?.key ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {} });
    if (!r.ok) { setErr("management view denied — server-authorized navigation required"); return; }
    setV(await r.json());
    setErr(null);
  }, []);
  useEffect(() => { void refresh(); const id = setInterval(refresh, 2500); return () => clearInterval(id); }, [refresh]);

  const awaiting = v?.receipts.find((x) => x.awaiting);
  const doneBeats = new Set((v?.receipts || []).filter((x) => !x.awaiting).map((x) => x.beat));
  const progress = Math.round((doneBeats.size / 10) * 100);

  async function post(path: string, body: object) {
    setBusy(true); setErr(null);
    try {
      const c = loadConfig();
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...(c?.key ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {}) }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      t0.current = Date.now();
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const running = awaitRunning();
  function awaitRunning() { return !!awaiting && doneBeats.size < 5; }

  return (
    <div className="mgmt">
      <div className="hub">
        <div className="hub-head"><span>🧠 QwenWork AI Brain — Orchestration Platform</span><span className="chip-led">{running ? "● Coordinating" : v?.receipts.length ? "● Ready" : "● Idle"}</span></div>
        <div className="mission">🎯 Mission: <b>{v?.mission !== "—" ? v?.mission : "run a demo below"}</b> <span className="test-badge">TEST</span></div>
        <div className="nodes six">
          {(v?.specialists || ["research", "catalog", "website", "marketing", "watch", "report"]).map((s) => {
            const beatByRole: Record<string, number> = { research: 3, catalog: 4, website: 4, marketing: 6, watch: 7, report: 10 };
            const beat = beatByRole[s] || 0;
            const state = doneBeats.has(beat) ? "✅" : running ? "⚙️" : "○";
            return <div key={s} className="node"><span className="nic">{ROLE_ICON[s] || "🧩"}</span>{s.startsWith("catalog") ? "catalog" : s.charAt(0).toUpperCase() + s.slice(1)} {state}</div>;
          })}
        </div>
        <div className="prog"><div className="prog-bar"><i style={{ width: `${progress}%` }} /></div><span>{progress}% · est {doneBeats.size ? `${Math.max(1, Math.round((Date.now() - t0.current) / 1000 / doneBeats.size) * (10 - doneBeats.size))}s` : "—"}</span></div>
      </div>

      {awaiting && (
        <div className="gate">
          <h4>👤 Human approval required — marketing spend <span className="test-badge">TEST</span></h4>
          <p>Beat 5 holds until you decide (R12). Approving resumes <b>drafts + simulation only</b> — no real payment, order, or send leaves this system.</p>
          <label className="caprow">Cap S$ <input type="number" min={10} max={500} value={cap} onChange={(e) => setCap(+e.target.value || 150)} /></label>
          <div className="gatebtns">
            <button className="g-ok" disabled={busy} onClick={() => post("/api/odai/demo/approve", { runId: awaiting.runId, approve: true, cap })}>👍 Approve S${cap}</button>
            <button className="g-no" disabled={busy} onClick={() => post("/api/odai/demo/approve", { runId: awaiting.runId, approve: false })}>✕ Decline & stop</button>
          </div>
        </div>
      )}

      <div className="tracebox">
        <div className="trace-head"><span>▱ AI Execution Trace (Live)</span><span className="live-dot">● Live</span></div>
        <ol>
          {(v?.trace || []).slice(-14).map((e, i) => (
            <li key={i}>
              <em>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</em>
              <b className={`dec ${e.decision === "ALLOW" ? "a" : e.decision === "NEVER" ? "n" : e.decision === "APPROVE" ? "h" : "i"}`}>{e.kind === "BEAT_DONE" ? `beat ${e.beat}` : e.kind.replace(/_/g, " ")}</b>
              <span>{e.actor ? `[${PHASE[e.beat ?? 0] ?? "SYNC"}] ` : ""}{e.note || e.kind}</span>
            </li>
          ))}
        </ol>
      </div>

      {err && <p className="mstat bad" style={{ margin: "0 10px 10px" }}>✕ {err}</p>}

      <div className="runbar">
        <input value={obj} onChange={(e) => setObj(e.target.value)} placeholder="objective for the 10-beat TEST demo" />
        <button className="mab solid" disabled={busy || running} onClick={() => post("/api/odai/demo/start", { objective: obj })}>▶ Run 3-min demo</button>
      </div>
      <p className="fineprint">Summaries are explainable decision records — private model reasoning is never shown (9.0 UI contract).</p>
    </div>
  );
}
