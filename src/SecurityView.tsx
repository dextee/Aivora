import { useCallback, useEffect, useState } from "react";

/* SECURITY MODE — AIVORA SHIELD per approved navy screen.
 * Everything shown is a SIMULATION (9.0 contract: label required,
 * no unverified effectiveness claims). Data = policy decisions from the
 * governed workflow receipts + trace. */
type Incident = { ts: string; kind: string; decision: string; rule?: string; containment?: string; simulation: string };
type SView = { label: string; shields: string[]; incidents: Incident[]; log: { ts: string; kind: string; beat?: number; decision?: string; note?: string }[]; data_mode: string };

const TILES = [
  ["Monitor", "Real-time AI behaviour", "#0EA5E9", "👁"],
  ["Check", "Verify rules & outputs", "#22C55E", "📋"],
  ["Filter", "Block malicious requests", "#A855F7", "🚫"],
  ["Contain", "Isolate risky actions (sandbox)", "#F59E0B", "📦"],
  ["Recover", "Auto-restore safe state", "#14B8A6", "♻️"],
  ["Audit", "Full log · ISO evidence", "#1E3A8A", "📜"],
];

export function SecurityView() {
  const [v, setV] = useState<SView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const r = await fetch(`/api/odai/view?mode=security&_t=${Date.now()}`);
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || "denied"); return; }
    setV(await r.json()); setErr(null);
  }, []);
  useEffect(() => { void refresh(); const id = setInterval(refresh, 4000); return () => clearInterval(id); }, [refresh]);

  return (
    <div className="sec">
      <div className="sec-hero">
        <h2>AIVORA SHIELD <span className="sim-badge">SIMULATION</span></h2>
        <p>AI Hacking Simulation &amp; Real-time Protection demonstration</p>
        <div className="ticks">{["Block", "Detect", "Contain", "Recover", "Audit"].map((t) => <span key={t}>✓ {t}</span>)}</div>
      </div>

      <div className="flow">
        <div className="f-threat">
          <h5>⚠ Incoming (simulated)</h5>
          <p>✕ Prompt injection<br />✕ Data theft<br />✕ Rogue command</p>
        </div>
        <div className="f-arrow">▶</div>
        <div className="f-shield">🛡<small>AIVORA SHIELD<br />6-layer defence</small></div>
        <div className="f-arrow">▶</div>
        <div className="f-safe">
          <h5>ATTACK BLOCKED</h5>
          <p>✓ No data leaked<br />✓ No rule broken<br />✓ No unauthorized action<br />✓ System safe &amp; running</p>
        </div>
      </div>

      <h4 className="seclabel-dark">6 Defence Mechanisms (AI watches AI) <span className="sim-badge sm">SIMULATED</span></h4>
      <div className="tiles">
        {TILES.map(([n, d, c, ic], i) => (
          <div key={i} className="tile" style={{ borderColor: c }}>
            <span className="tic" style={{ background: c }}>{ic}</span><b>{i + 1}. {n}</b><small>{d}</small>
          </div>
        ))}
      </div>

      <div className="seclg">
        <div className="trace-head"><span>▱ Real-Time Security Log</span><span className="live-dot red">● LIVE</span></div>
        <ol>
          {(v?.log || []).slice(-12).reverse().map((e, i) => (
            <li key={i}>
              <em>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</em>
              <b className={e.decision === "NEVER" ? "n" : e.decision === "APPROVE" ? "h" : "a"}>{e.kind === "BEAT_DONE" ? `BEAT ${e.beat}` : e.kind.replace(/_/g, " ").toUpperCase()}</b>
              <span>{e.note}</span>
            </li>
          ))}
          {!v?.log.length && <li><span>Run the demo in Management Mode to populate the shield log (watch-block at beat 7 raises a real policy decision, marked as simulation).</span></li>}
        </ol>
      </div>

      <div className="incibar">
        <div><b>{v?.incidents.length ?? 0}</b><label>simulated incidents intercepted</label></div>
        <div className="ekg"><svg viewBox="0 0 120 24" preserveAspectRatio="none"><path d="M0 12h18l6-9 8 18 7-12 5 6 6-3h62" fill="none" stroke="#22C55E" strokeWidth="1.6"><animate attributeName="stroke-dasharray" values="0 400;400 0" dur="2.6s" repeatCount="indefinite" /></path></svg></div>
        <div><b>ACTIVE</b><label>protection state · simulation only</label></div>
      </div>
      <p className="fineprint">No effectiveness percentages or certification claims are shown — security efficacy is unverified (9.0 governance).</p>
      {err && <p className="mstat bad">✕ {err}</p>}
    </div>
  );
}
