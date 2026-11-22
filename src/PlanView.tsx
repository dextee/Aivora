import { useEffect, useRef, useState } from "react";

/* Launch — the 7-panel Objective-to-Task execution interface for the coffee-business demo command.
 * Drives the SAME unified /submit entry the voice path uses (typed fallback here). Reuses the plan engine;
 * does NOT rebuild voice. Live audio needs a key (handled in Speak-to-AIVORA); this screen is the typed/visual surface. */
interface Task { task_id: string; title: string; assigned_agent: string; skill_id: string | null; dependencies: string[]; status: string; attempt_count: number; execution_result: any; verification_result: any; }
interface Plan {
  objective_id: string; state: string;
  extracted: { business_objective: string; product: string; selling_price: number; currency: string; required_business_outcomes: string[]; target_customers: string; required_agents: string[]; required_integrations: string[]; execution_constraints: string[]; approval_requirements: string[] };
  progress: { total: number; done: number; simulated: number; held: number; failed: number; pending: number };
  tasks: Task[]; note?: string;
}

const DEMO = "AIVORA, launch my coffee business. Create my online store, generate a marketing campaign and follow up with customers.";
const icon = (s: string) => (s === "done" ? "✅" : s === "simulated" ? "🧪" : s === "held" ? "⏸" : s === "failed" ? "❌" : "⏳");

export function PlanView() {
  const [text, setText] = useState(DEMO);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [hm, setHm] = useState<any>(null);
  const poll = useRef<number | null>(null);

  async function fetchHm() { try { const j = await (await fetch(`/api/odai/hashmeta/status?_t=${Date.now()}`)).json(); if (j && !j.error) setHm(j); } catch { /* adapter not initialized */ } }

  async function launch(cmd: string) {
    if (!cmd.trim() || busy) return;
    setBusy(true); setErr(null); setTranscript(cmd);
    try {
      const j = await (await fetch(`/api/odai/submit?_t=${Date.now()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: cmd, request_id: `typed:${cmd}`, source: "typed" }) })).json();
      if (j.error) { setErr(j.error); } else { setPlan(j as Plan); startPoll(j.objective_id); }
    } catch { setErr("Can't reach the objective engine."); }
    finally { setBusy(false); }
  }
  function startPoll(id: string) {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      try { const j = await (await fetch(`/api/odai/plan/${id}?_t=${Date.now()}`)).json(); if (j.tasks) setPlan(j as Plan); } catch { /* keep last */ }
    }, 2000);
  }
  useEffect(() => { void fetchHm(); return () => { if (poll.current) window.clearInterval(poll.current); }; }, []);

  const card: React.CSSProperties = { border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 14 };
  const agents = plan ? Array.from(new Set(plan.tasks.map((t) => t.assigned_agent))) : [];
  const pct = plan ? Math.round(((plan.progress.done + plan.progress.simulated + plan.progress.held) / Math.max(1, plan.progress.total)) * 100) : 0;
  const artifacts = plan ? plan.tasks.filter((t) => (t.status === "done" || t.status === "simulated") && t.execution_result) : [];

  return (
    <div className="view" style={{ padding: 16, maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 1. Live transcription / typed fallback */}
      <section style={card}>
        <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>🎙 Live transcription · typed fallback</h3>
        <p style={{ fontSize: 11, color: "var(--ink2)", margin: "0 0 8px" }}>Voice runs in “Speak to AIVORA” (needs a model key). Type or use the demo command below — it goes through the same engine.</p>
        <textarea className="q4input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="q4send" style={{ padding: "8px 16px" }} onClick={() => void launch(text)} disabled={busy}>Execute objective</button>
          <button className="q4send" style={{ padding: "8px 16px", opacity: .7 }} onClick={() => void launch(DEMO)} disabled={busy}>Use demo command</button>
        </div>
        {transcript && <p style={{ fontSize: 12, margin: "8px 0 0", fontStyle: "italic" }}>Heard: “{transcript}”</p>}
      </section>

      {err && <p style={{ color: "#e0655f", fontSize: 12 }}>{err}</p>}

      {plan && (
        <>
          {/* 2. Recognized business objective */}
          <section style={card}>
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>🎯 Recognized business objective</h3>
            <p style={{ fontSize: 13, margin: 0 }}>{plan.extracted.business_objective}</p>
            <p style={{ fontSize: 12, color: "#3fb37f", margin: "8px 0 0" }}>🗣 “I have created your coffee business — I am assigning the store, marketing and sales agents to execute your campaign.”</p>
            <small style={{ color: "var(--ink2)", fontSize: 11 }}>objective {plan.objective_id} · state {plan.state}</small>
          </section>

          {/* 3. Extracted business requirements */}
          <section style={card}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>📋 Extracted business requirements</h3>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12.5 }}>
              <span style={{ color: "var(--ink2)" }}>Product</span><span>{plan.extracted.product}</span>
              <span style={{ color: "var(--ink2)" }}>Price</span><span>{plan.extracted.currency} {plan.extracted.selling_price}</span>
              <span style={{ color: "var(--ink2)" }}>Currency</span><span>{plan.extracted.currency}</span>
              <span style={{ color: "var(--ink2)" }}>Target customers</span><span>{plan.extracted.target_customers}</span>
              <span style={{ color: "var(--ink2)" }}>Outcomes</span><span>{plan.extracted.required_business_outcomes.join(" · ")}</span>
              <span style={{ color: "var(--ink2)" }}>Integrations</span><span>{plan.extracted.required_integrations.join(" · ")}</span>
              <span style={{ color: "var(--ink2)" }}>Approvals</span><span>{plan.extracted.approval_requirements.join(" · ")}</span>
              <span style={{ color: "var(--ink2)" }}>Constraints</span><span>{plan.extracted.execution_constraints.join(" · ")}</span>
            </div>
          </section>

          {/* 4 + 5 + 6. Plan, assigned agents, live progress */}
          <section style={card}>
            <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>🧭 AI-generated execution plan · 🤖 assigned agents · 📊 live progress</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0 10px" }}>
              <span style={{ fontSize: 11, background: "rgba(63,179,127,.15)", color: "#3fb37f", padding: "2px 8px", borderRadius: 999 }}>done {plan.progress.done}</span>
              <span style={{ fontSize: 11, background: "rgba(224,162,58,.15)", color: "#e0a23a", padding: "2px 8px", borderRadius: 999 }}>simulated {plan.progress.simulated}</span>
              <span style={{ fontSize: 11, background: "rgba(120,130,160,.18)", color: "var(--ink2)", padding: "2px 8px", borderRadius: 999 }}>held {plan.progress.held}</span>
              <span style={{ fontSize: 11, background: "rgba(224,101,95,.15)", color: "#e0655f", padding: "2px 8px", borderRadius: 999 }}>failed {plan.progress.failed}</span>
              <span style={{ fontSize: 11, color: "var(--ink2)" }}>agents: {agents.join(", ")}</span>
            </div>
            <div style={{ height: 8, background: "rgba(255,255,255,.08)", borderRadius: 6, overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#0e6b6b,#3fb37f)" }} /></div>
            <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
              {plan.tasks.map((t) => (
                <li key={t.task_id} style={{ fontSize: 12.5 }}>
                  {icon(t.status)} <b>{t.task_id}</b> {t.title}
                  <span style={{ color: "var(--ink2)" }}> — {t.assigned_agent}{t.skill_id ? ` (${t.skill_id})` : ""}{t.dependencies.length ? ` · after ${t.dependencies.join("+")}` : ""}{t.attempt_count > 1 ? ` · healed (${t.attempt_count} attempts)` : ""}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* 7. Generated business artifacts (completed only when verified) */}
          <section style={card}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>📦 Generated business artifacts</h3>
            {artifacts.length === 0 && <p style={{ fontSize: 12, color: "var(--ink2)" }}>No verified artifacts yet.</p>}
            {artifacts.map((t) => (
              <div key={t.task_id} style={{ borderTop: "1px solid var(--line,#2a2f45)", padding: "8px 0", fontSize: 12 }}>
                <b>{t.task_id}</b> {t.title}
                <div style={{ color: "var(--ink2)", marginTop: 2 }}>
                  {t.status === "simulated" ? "🧪 SIMULATED — " : t.verification_result?.ok ? "✅ verified — " : "⚠️ unverified — "}
                  {JSON.stringify(t.execution_result).slice(0, 220)}
                </div>
              </div>
            ))}
            <p style={{ fontSize: 11, color: "var(--ink2)", margin: "8px 0 0" }}>Publishing (T08) and follow-up sending (T11) are HELD for owner approval — external comms/paid ads are NEVER in this build. “Completed” is shown only after a verified execution result.</p>
          </section>

          {hm && (
            <section style={card}>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>🔌 Hashmeta adapter</h3>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12.5 }}>
                <span style={{ color: "var(--ink2)" }}>Connectivity mode</span><span style={{ color: hm.connectivity_mode === "live" ? "#3fb37f" : "#e0a23a" }}>{hm.connectivity_mode}</span>
                <span style={{ color: "var(--ink2)" }}>Execution status</span><span>{hm.lifecycle}</span>
                <span style={{ color: "var(--ink2)" }}>Approval</span><span>{hm.approval}</span>
                <span style={{ color: "var(--ink2)" }}>External effects</span><span>{hm.external_effects}</span>
                <span style={{ color: "var(--ink2)" }}>Publication confirmed</span><span>{hm.confirmed_publication ? "✅ yes (provider-confirmed)" : "no"}</span>
              </div>
              <p style={{ fontSize: 11, color: "var(--ink2)", margin: "8px 0 0" }}>Sandbox mode = no HASHMETA_API_TOKEN; the adapter runs the identical skill interface locally and never claims a real external publication.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
