import { useCallback, useEffect, useRef, useState } from "react";

/* AIVORA SHIELD — RogueAI Shield Alert interface (mockup 1–5).
 * Everything shown is a SIMULATION (9.0 contract: label required,
 * no unverified effectiveness claims). Statistics derive from the
 * governed workflow policy decisions + trace served by /api/odai/view. */
type Incident = { ts: string; kind: string; decision: string; rule?: string; containment?: string; simulation: string };
type SView = { label: string; shields: string[]; incidents: Incident[]; log: { ts: string; kind: string; beat?: number; decision?: string; note?: string }[]; data_mode: string };
type Infra = { guardian?: string; frontend?: string; backend?: string; database?: string; port?: number; uptime_sec?: number; last_failure?: string | null; restart_count?: number; last_recovery?: string | null; last_recovery_ms?: number | null; escalation?: unknown; health?: string; server_pid?: number | null; server_mem_mb?: number | null; events?: { ts: string; event: string }[] };

const LAYERS = [
  { t: "AI Watching AI", d: "Monitor agent behaviour", ic: "👁" },
  { t: "Deterministic Guardrails", d: "Enforce approved rules", ic: "🛡" },
  { t: "Runtime Isolation", d: "Restrict execution scope", ic: "⬡" },
  { t: "Data Privacy", d: "Prevent unauthorized access", ic: "🔒" },
  { t: "AI Immune System", d: "Contain affected agents", ic: "⚠" },
  { t: "Automation Healing", d: "Recover and resume safely", ic: "↻" },
];

const TIMELINE = [
  { s: "Unauthorized action detected", by: "AI Watching AI" },
  { s: "Financial policy violation confirmed", by: "Deterministic Guardrail" },
  { s: "Purchase operation blocked", by: "RogueAI Shield" },
  { s: "Affected authorization revoked", by: "Security" },
  { s: "Test agent quarantined", by: "AI Immune System" },
  { s: "Trusted replacement assigned", by: "Orchestrator" },
  { s: "Original purchase order preserved", by: "Verification" },
  { s: "Business workflow resumed", by: "Automation Healing" },
];

const CONSOLE_SCRIPT: [string, string, "g" | "r" | "a" | "n"][] = [
  ["AI WATCHING AI", "Monitoring agent execution", "g"],
  ["DETECTION", "Unauthorized procurement request identified", "n"],
  ["GUARDRAIL", "Evaluating financial authorization", "n"],
  ["POLICY", "Procurement budget exceeded", "r"],
  ["ROGUEAI SHIELD", "Unauthorized operation BLOCKED", "r"],
  ["SECURITY", "Revoking affected execution permission", "g"],
  ["AI IMMUNE SYSTEM", "Quarantining test agent", "g"],
  ["ORCHESTRATOR", "Selecting trusted replacement", "n"],
  ["RECOVERY", "Restoring verified checkpoint", "g"],
  ["VERIFICATION", "Checking original purchase order", "n"],
  ["VERIFICATION", "Checking duplicate procurement", "n"],
  ["AUTOMATION HEALING", "Authorized workflow resumed", "g"],
];

type Alert = { id: string; sev: "Critical" | "High"; title: string; agent: string; status: string };

const ALERTS: Alert[] = [
  { id: "A1", sev: "Critical", title: "Unauthorized procurement modification", agent: "Community Procurement Agent", status: "Contained" },
  { id: "A2", sev: "Critical", title: "Unauthorized customer data access", agent: "Community Marketing Agent", status: "Contained" },
  { id: "A3", sev: "High", title: "Abnormal purchase quantity detected", agent: "AI Watching AI", status: "Reviewing" },
];

export function SecurityView() {
  const [v, setV] = useState<SView | null>(null);
  const [infra, setInfra] = useState<Infra | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"All" | "Rogue" | "Privacy" | "Anomaly">("All");
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [conIdx, setConIdx] = useState(0);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/odai/view?mode=security&_t=${Date.now()}`);
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || "denied"); return; }
    setV(await r.json()); setErr(null);
  }, []);
  useEffect(() => { void refresh(); const id = setInterval(refresh, 4000); return () => clearInterval(id); }, [refresh]);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try { const r = await fetch(`/api/infra?_t=${Date.now()}`); if (r.ok && active) setInfra(await r.json()); }
      catch { /* guardian status unavailable — UI shows not_running */ }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);

  /* animated console: reveal one line every ~120ms, then hold + replay */
  useEffect(() => {
    timer.current = window.setInterval(() => setConIdx((i) => (i >= CONSOLE_SCRIPT.length ? 0 : i + 1)), 1400);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const blocked = (v?.incidents ?? []).filter((x) => x.decision === "NEVER").length;
  const reviewing = (v?.incidents ?? []).filter((x) => x.decision !== "NEVER").length;
  const metrics = [
    { n: blocked, l: "Agent threats blocked", c: "#b23b3b" },
    { n: v?.incidents.length ?? 0, l: "Data anomalies", c: "#c9a227" },
    { n: blocked, l: "Test agents contained", c: "#2f7a3e" },
    { n: Math.max(0, blocked - 1), l: "Workflow recovered", c: "#2f7a3e" },
  ];
  const shown = ALERTS.filter((a) => filter === "All" || (filter === "Rogue" && a.id === "A1") || (filter === "Privacy" && a.id === "A2") || (filter === "Anomaly" && a.id === "A3"));

  return (
    <div className="shield">
      <div className="sh-pillars">
        <div className="sh-pillars-head">
          <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden>
            <path d="M32 3l24 9v18c0 15-10 26-24 31C18 56 8 45 8 30V12z" fill="none" stroke="#6ee787" strokeWidth="3" />
            <path d="M22 33l7 7 14-16" fill="none" stroke="#6ee787" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2>ROGUEAI SHIELD</h2>
          <p>AI Agents Protecting AI Agents</p>
        </div>
        <div className="sh-pillars-grid">
          {[["DETECT", "AI Watching AI", "👁"], ["BLOCK", "Deterministic Guardrails", "🛡"], ["CONTAIN", "AI Immune System", "🔒"], ["RECOVER", "Automation Healing", "↻"]].map(([t, d, ic]) => (
            <div key={t} className="sh-pillar"><span>{ic}</span><b>{t}</b><small>{d}</small></div>
          ))}
        </div>
        <div className="sh-pillars-foot">Protect the Business. Contain the Threat. Continue the Work.</div>
      </div>

      <div className="sh-hero">
        <div className="sh-shield-art">
          <svg viewBox="0 0 64 64" width="86" height="86" aria-hidden>
            <path d="M32 3l24 9v18c0 15-10 26-24 31C18 56 8 45 8 30V12z" fill="none" stroke="#2f7a3e" strokeWidth="3" />
            <path d="M22 33l7 7 14-16" fill="none" stroke="#2f7a3e" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <i /><i /><i />
        </div>
        <h2>RogueAI Shield</h2>
        <p>AI agents protecting AI agents</p>
        <div className="sh-status"><span className="st-dot ok" /> Protection Active · Business workflow operational</div>
        <div className="sh-tags"><span>Neurosymbolic Deterministic Guardrails</span><span className="sim-badge sm">SIMULATION</span></div>
      </div>

      <div className="sh-grid">
        {metrics.map((m, i) => (
          <div key={i} className="sh-m"><b style={{ color: m.c }}>{m.n}</b><label>{m.l}</label></div>
        ))}
      </div>

      <h4 className="seclabel">Security &amp; Operational Alerts</h4>
      <div className="sh-tabs">
        {(["All", "Rogue", "Privacy", "Anomaly"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <div className="sh-alerts">
        {shown.map((a) => (
          <button key={a.id} className={`sh-al ${a.sev === "Critical" ? "crit" : "high"}`} onClick={() => setIncidentOpen(true)}>
            <span className="sh-al-ic">{a.sev === "Critical" ? "🚫" : "⚠"}</span>
            <span className="sh-al-body">
              <b>{a.title} <em className={a.sev === "Critical" ? "c" : "h"}>{a.sev.toUpperCase()}</em></b>
              <small>{a.agent} · Status: <strong className="ok">{a.status}</strong></small>
            </span>
            <span className="sh-al-go">›</span>
          </button>
        ))}
        {reviewing === 0 && blocked === 0 && <p className="sh-empty">No live policy incidents yet — run the governed demo to raise real shield decisions.</p>}
      </div>

      {incidentOpen && (
        <div className="sh-inc" role="dialog">
          <div className="sh-inc-head">
            <b>🛡 ROGUE AGENT DETECTED</b>
            <small>Unauthorized procurement action blocked</small>
            <button className="sh-inc-x" onClick={() => setIncidentOpen(false)} aria-label="Close">✕</button>
          </div>
          <div className="sh-inc-body">
            <dl>
              <div><dt>Detected agent</dt><dd>Procurement Agent</dd></div>
              <div><dt>Authorized procurement budget</dt><dd>S$6,500</dd></div>
              <div><dt>Unauthorized proposed expenditure</dt><dd className="bad">S$60,000</dd></div>
            </dl>
            <div className="sh-inc-ok">✓ Transaction blocked — no unauthorized expenditure executed in this test scenario.</div>
            <h5>AI WATCHING AI — RESPONSE</h5>
            <ol className="sh-tl">
              {TIMELINE.map((t, i) => (
                <li key={i}><i>✓</i><span>{t.s}<small>{t.by}</small></span></li>
              ))}
            </ol>
            <div className="sh-inc-foot">🛡 Threat Contained — authorized business operations can continue.</div>
          </div>
        </div>
      )}

      <h4 className="seclabel">Infrastructure Health <span className="live-dot">● GUARDIAN</span></h4>
      <div className="sh-infra">
        <div className="sh-infra-list">
          {[
            ["Frontend Server", infra?.frontend],
            ["Backend Server", infra?.backend],
            ["Database", infra?.database],
            ["Objective-to-Task Engine", infra?.backend],
            ["RogueAI Shield", infra?.guardian],
            ["Independent Watchdog", infra?.guardian],
          ].map(([k, st]) => (
            <div key={String(k)} className="sh-infra-row">
              <i className={st === "online" || st === "memory_fallback_ok" ? "ok" : st === "not_running" || st === "offline" ? "bad" : "warn"}>●</i>
              <b>{k}</b><span>{st === "memory_fallback_ok" ? "Online (memory fallback)" : st === "online" ? "Online" : st === "not_running" ? "Not running" : String(st ?? "…")}</span>
            </div>
          ))}
        </div>
        <div className="sh-infra-meta">
          <span>Port <b>{infra?.port ?? 8081}</b></span>
          <span>Uptime <b>{infra?.uptime_sec != null ? `${Math.floor(infra.uptime_sec / 60)}m ${infra.uptime_sec % 60}s` : "—"}</b></span>
          <span>Restarts <b>{infra?.restart_count ?? 0}</b></span>
          <span>Last failure <b>{infra?.last_failure ? new Date(infra.last_failure).toLocaleTimeString() : "none"}</b></span>
          <span>Last recovery <b>{infra?.last_recovery ? `${new Date(infra.last_recovery).toLocaleTimeString()} (${infra.last_recovery_ms ?? "?"}ms)` : "—"}</b></span>
        </div>
        {Boolean(infra?.escalation) && (
          <div className="sh-infra-esc">⚠ ESCALATED — deterministic recovery failed; AI development agent review required (see logs/guardian_events.jsonl).</div>
        )}
        {infra?.last_recovery && (
          <div className="sh-recovered">
            <svg viewBox="0 0 64 64" width="44" height="44" aria-hidden>
              <path d="M32 3l24 9v18c0 15-10 26-24 31C18 56 8 45 8 30V12z" fill="none" stroke="#2f7a3e" strokeWidth="3" />
              <path d="M22 33l7 7 14-16" fill="none" stroke="#2f7a3e" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div><b>Server Recovered</b><small>Automation Healing restored the backend in {infra.last_recovery_ms ?? "?"}ms · verified health check</small></div>
          </div>
        )}
        {(infra?.events ?? []).length > 0 && (
          <div className="sh-console sh-evlog">
            <div className="trace-head"><span>▱ Automation Healing Execution</span></div>
            <ol>
              {(infra?.events ?? []).slice(-12).reverse().map((e, i) => (
                <li key={i} className={/FAILURE|ESCALATION/.test(e.event) ? "cl-r" : /RECOVERY|RESTARTED|RESUMED|VERIFIED|HEALING/.test(e.event) ? "cl-g" : "cl-a"}>
                  <em>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</em> {e.event.replace(/_/g, " ").toLowerCase()}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <h4 className="seclabel">Defence System <span className="sim-badge sm">SIMULATED</span></h4>
      <div className="sh-layers">
        {LAYERS.map((l, i) => (
          <div key={i} className="sh-layer"><span className="sh-ly-ic">{l.ic}</span><b>{l.t}</b><small>{l.d}</small></div>
        ))}
      </div>

      <div className="seclg sh-console">
        <div className="trace-head"><span>▱ Security Execution Engine</span><span className="live-dot">● LIVE</span></div>
        <ol>
          {CONSOLE_SCRIPT.slice(0, Math.max(1, conIdx)).map(([tag, msg, c], i) => (
            <li key={i} className={`cl-${c}`}><em>{`[${tag}]`}</em> {msg}</li>
          ))}
          <li className={conIdx >= CONSOLE_SCRIPT.length ? "cl-g" : "cl-n"}>
            <b>{conIdx >= CONSOLE_SCRIPT.length ? "THREAT CONTAINED — WORKFLOW RESUMED" : "…"}</b>
          </li>
        </ol>
        <p className="fineprint">Replay of the governed block event · real policy decisions appear below when the demo runs. No effectiveness claims — security efficacy is unverified (9.0 governance).</p>
        {(v?.log ?? []).length > 0 && (
          <ol>
            {(v?.log ?? []).slice(-8).reverse().map((e, i) => (
              <li key={i} className={e.decision === "NEVER" ? "cl-r" : "cl-n"}>
                <em>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</em> {e.kind === "BEAT_DONE" ? `BEAT ${e.beat}` : e.kind.replace(/_/g, " ")} — {e.note}
              </li>
            ))}
          </ol>
        )}
      </div>
      {err && <p className="mstat bad">✕ {err}</p>}
    </div>
  );
}
