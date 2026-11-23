import { useEffect, useState } from "react";
import { getAccessToken } from "./auth";

type Case = { id: string; category: string; description: string; scope: string };
type Result = { case_id: string; category: string; description: string; scope: string; status: string; observed?: string; reason?: string; skills?: string[]; gmail_message_id?: string; duration_ms?: number; verifier?: string; evidence?: Record<string, unknown>; security_evidence?: Record<string, unknown>; live_gmail?: string };
type Report = { run_id: string; build: string; total: number; passed: number; failed: number; blocked: number; live_gmail: string; sandbox_adapter: string; cases: Result[]; independent_verification: { case_id: string; claimed: string; verdict: string; note?: string }[]; remaining_limitations: string[] };

async function api(path: string, init?: RequestInit) {
  const token = getAccessToken();
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return j;
}
const CATEGORIES = ["Inbox Management", "Voice-to-Email Automation", "Customer Transaction Automation", "Security and Automation Healing"];
const statusClass = (s: string) => s === "PASS" ? "tl-pass" : s === "FAIL" ? "tl-fail" : "tl-blocked";

export function TestLabView() {
  const [cases, setCases] = useState<Case[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string>("");
  const [error, setError] = useState("");
  const [console_, setConsole] = useState<string[]>([]);

  useEffect(() => { void api("/api/odai/testlab/cases").then((j) => setCases(j.cases || [])).catch((e) => setError((e as Error).message)); }, []);

  function log(line: string) { setConsole((c) => [...c.slice(-60), line]); }
  async function run(caseId?: string) {
    setBusy(true); setError(""); setRunning(caseId || "ALL");
    log(`TEST_VERIFICATION_STARTED ${caseId || "ALL CASES"}`);
    try {
      const j = await api("/api/odai/testlab/run", { method: "POST", body: JSON.stringify(caseId ? { case_id: caseId } : {}) });
      setReport(j);
      for (const c of j.cases) log(`${c.case_id} [${c.status}] ${c.observed || c.reason || ""}`);
      log(`TEST_VERIFICATION_COMPLETED — PASS ${j.passed} / FAIL ${j.failed} / BLOCKED ${j.blocked}`);
    } catch (e) { setError((e as Error).message); log("ERROR " + (e as Error).message); }
    setBusy(false); setRunning("");
  }

  const verdictOf = (id: string) => report?.independent_verification?.find((v) => v.case_id === id);

  return <main className="view inbox-view">
    <div className="inbox-heading"><div><h1>Inbox Test Lab</h1><p>Automated acceptance testing of My Inbox, Voice-to-Email, transactions, security &amp; healing.</p></div><button disabled={busy} onClick={() => void run()}>▶ Run All Tests</button></div>
    {error && <p role="alert" className="inbox-card">{error}</p>}
    <section className="inbox-card"><p>Sandbox adapter runs against the real engines. <b>Live Gmail</b> and <b>voice audio</b> cases are marked BLOCKED when credentials/microphone are unavailable — never fabricated as PASS.</p></section>

    {report && <section className="inbox-card">
      <div className="cust-stats">
        <div className="cust-stat"><b>{report.total}</b><label>Total</label></div>
        <div className="cust-stat tl-pass"><b>{report.passed}</b><label>Pass</label></div>
        <div className="cust-stat tl-fail"><b>{report.failed}</b><label>Fail</label></div>
        <div className="cust-stat tl-blocked"><b>{report.blocked}</b><label>Blocked</label></div>
      </div>
      <p>Run <code>{report.run_id}</code> · build {report.build}</p>
      <p>Live Gmail: {report.live_gmail} · Sandbox: {report.sandbox_adapter}</p>
      <div className="inbox-actions">
        <a className="inbox-primary" href={`/api/odai/testlab/report/${encodeURIComponent(report.run_id)}/pdf`} download>⬇ Download PDF Report</a>
        <a className="inbox-primary" href={`/api/odai/testlab/report/${encodeURIComponent(report.run_id)}/xlsx`} download>⬇ Download Excel Results</a>
      </div>
    </section>}

    {CATEGORIES.map((cat) => (
      <section className="inbox-card" key={cat}>
        <h2>{cat}</h2>
        {cases.filter((c) => c.category === cat).map((c) => {
          const r = report?.cases.find((x) => x.case_id === c.id);
          const v = verdictOf(c.id);
          return <div className="tl-case" key={c.id}>
            <div className="inbox-heading">
              <span><b>{c.id}</b> · {c.description} <small>({c.scope})</small></span>
              <span>{r ? <span className={statusClass(r.status)}>{r.status}</span> : <button disabled={busy} onClick={() => void run(c.id)}>{running === c.id ? "running…" : "Run"}</button>}</span>
            </div>
            {r && <>
              <p className="tl-observed">{r.observed || r.reason}</p>
              {r.gmail_message_id && <p>Gmail message: <code>{r.gmail_message_id}</code>{r.live_gmail ? ` · live: ${r.live_gmail}` : ""}</p>}
              {v && <p className="tl-verifier">DEV-11: {v.verdict}{v.note ? ` — ${v.note}` : ""}</p>}
              <details><summary>Evidence &amp; skills</summary>
                <p>Skills: {(r.skills || []).join(", ") || "—"} · {r.duration_ms}ms</p>
                <pre>{JSON.stringify(r.evidence || {}, null, 2)}</pre>
                {r.security_evidence && <pre>{JSON.stringify(r.security_evidence, null, 2)}</pre>}
              </details>
            </>}
          </div>;
        })}
      </section>
    ))}

    {console_.length > 0 && <section className="inbox-card"><h2>Live Execution</h2><div className="appt-exec">{console_.map((l, i) => <p key={i}>✓ {l}</p>)}</div></section>}

    {report && <section className="inbox-card"><h2>Remaining limitations</h2>{report.remaining_limitations.map((l) => <p key={l}>• {l}</p>)}</section>}
  </main>;
}