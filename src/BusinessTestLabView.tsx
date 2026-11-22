import { useEffect, useMemo, useState } from "react";

type Case = { id: string; category: string; description: string; scope: string };
type Result = { case_id: string; category: string; description: string; status: "PASS" | "FAIL" | "BLOCKED"; observed?: string; reason?: string; evidence?: Record<string, unknown>; skills?: string[]; duration_ms?: number; verifier?: string };
type Report = { run_id: string; build: string; dataset: string; total: number; passed: number; failed: number; blocked: number; by_category: Record<string, { pass: number; fail: number; blocked: number }>; overall_acceptance: string; cases: Result[]; independent_verification: { case_id: string; verdict: string; note: string }[]; known_limitations: string[]; remaining_blockers: { case_id: string; reason: string }[] };

const GROUPS = ["Business Intelligence", "Purchase Orders", "Purchase Order History", "Customer List", "Cross-Module"];

async function api(path: string, init?: RequestInit) {
  const token = localStorage.getItem("aivora.auth.token") || "";
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  const text = await res.text();
  let data: unknown = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data;
}
const statusColor = (s: string) => (s === "PASS" ? "#0e6b57" : s === "FAIL" ? "#b42318" : "#b54708");

export function BusinessTestLabView() {
  const [cases, setCases] = useState<Case[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const [console_, setConsole] = useState<string[]>([]);
  const [openCase, setOpenCase] = useState<string>("");
  const log = (l: string) => setConsole((c) => [...c.slice(-80), l]);

  useEffect(() => { api("/api/odai/bizlab/cases").then((d) => setCases((d as { cases: Case[] }).cases || [])).catch((e) => setError(e.message)); }, []);
  const byGroup = useMemo(() => { const m: Record<string, Case[]> = {}; for (const g of GROUPS) m[g] = []; for (const c of cases) (m[c.category] ||= []).push(c); return m; }, [cases]);

  async function run(body: Record<string, string>) {
    setBusy(true); setError(""); setConsole([]);
    const label = body.case_id || body.category || "ALL 45";
    setRunning(label); log(`▶ running ${label} …`);
    try {
      const rep = (await api("/api/odai/bizlab/run", { method: "POST", body: JSON.stringify(body) })) as Report;
      setReport(rep);
      for (const c of rep.cases) log(`${c.status === "PASS" ? "✅" : c.status === "FAIL" ? "❌" : "⛔"} ${c.case_id} ${c.status} (${c.duration_ms}ms) ${c.observed ? "— " + String(c.observed).slice(0, 80) : c.reason ? "— " + String(c.reason).slice(0, 80) : ""}`);
      const rej = (rep.independent_verification || []).filter((v) => v.verdict === "REJECTED");
      log(`■ DEV-11: ${rej.length ? rej.length + " REJECTED" : "all confirmed"}`);
      log(`■ SUMMARY: ${rep.passed} PASS / ${rep.failed} FAIL / ${rep.blocked} BLOCKED of ${rep.total} — ${rep.overall_acceptance}`);
    } catch (e) { setError((e as Error).message); log("✖ " + (e as Error).message); }
    finally { setBusy(false); setRunning(""); }
  }

  return (
    <div className="bizlab">
      <header className="bizlab-head">
        <h2>Business Integration Test Lab</h2>
        <p className="bizlab-sub">45 mandatory cases · real engines · imported workbook dataset · independent DEV-11 verification</p>
        <div className="bizlab-actions">
          <button className="btn-primary" disabled={busy} onClick={() => run({})}>{busy ? "Running…" : "Run All 45 Tests"}</button>
          {report && (<>
            <a className="btn-ghost" href={`/api/odai/bizlab/report/${encodeURIComponent(report.run_id)}/pdf`} download>Download PDF</a>
            <a className="btn-ghost" href={`/api/odai/bizlab/report/${encodeURIComponent(report.run_id)}/xlsx`} download>Download Excel</a>
          </>)}
        </div>
        {report && (
          <div className="bizlab-summary">
            <span style={{ color: "#0e6b57" }}>{report.passed} PASS</span>
            <span style={{ color: "#b42318" }}>{report.failed} FAIL</span>
            <span style={{ color: "#b54708" }}>{report.blocked} BLOCKED</span>
            <span className="bizlab-accept">{report.overall_acceptance}</span>
          </div>
        )}
      </header>

      {error && <div className="bizlab-error">{error}</div>}

      <div className="bizlab-groups">
        {GROUPS.map((g) => (
          <section key={g} className="bizlab-group">
            <div className="bizlab-group-head">
              <h3>{g} <span className="bizlab-count">{(byGroup[g] || []).length}</span></h3>
              <button className="btn-small" disabled={busy} onClick={() => run({ category: g })}>Run Module</button>
            </div>
            <ul className="bizlab-cases">
              {(byGroup[g] || []).map((c) => {
                const r = report?.cases.find((x) => x.case_id === c.id);
                return (
                  <li key={c.id} className="bizlab-case">
                    <button className="bizlab-case-main" disabled={busy} onClick={() => run({ case_id: c.id })}>
                      <span className="bizlab-id">{c.id}</span>
                      <span className="bizlab-desc">{c.description}</span>
                      {r && <span className="bizlab-status" style={{ background: statusColor(r.status) }}>{r.status}</span>}
                      {c.scope === "audio" && <span className="bizlab-tag">audio</span>}
                    </button>
                    {r && (
                      <button className="bizlab-evidence-toggle" onClick={() => setOpenCase(openCase === c.id ? "" : c.id)}>
                        {openCase === c.id ? "Hide evidence ▲" : "View evidence ▼"}
                      </button>
                    )}
                    {r && openCase === c.id && (
                      <div className="bizlab-evidence">
                        <div><b>Observed:</b> {r.observed || r.reason}</div>
                        {r.skills && r.skills.length > 0 && <div><b>Skills:</b> {r.skills.join(", ")}</div>}
                        <div><b>Verifier:</b> {r.verifier}</div>
                        <pre>{JSON.stringify(r.evidence, null, 2)}</pre>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {report && report.remaining_blockers.length > 0 && (
        <section className="bizlab-blockers">
          <h3>Remaining blockers (not counted as PASS)</h3>
          <ul>{report.remaining_blockers.map((b) => <li key={b.case_id}><b>{b.case_id}</b> — {b.reason}</li>)}</ul>
        </section>
      )}

      <section className="bizlab-console">
        <h3>Live execution {running && <span className="bizlab-running">running {running}…</span>}</h3>
        <pre>{console_.join("\n") || "Run a test to see live execution."}</pre>
      </section>
    </div>
  );
}
