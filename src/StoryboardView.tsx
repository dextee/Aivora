import { useEffect, useState } from "react";

type Scene = { n: number; title: string; judge_sees: string };
type SceneResult = { scene: number; title: string; judge_sees: string; status: "PASS" | "FAIL" | "BLOCKED"; observed?: string; reason?: string; evidence?: Record<string, unknown>; events?: { step: number; agent: string; line: string; status: string }[]; audio_blocked?: boolean; duration_ms?: number };
type Run = { build: string; total: number; passed: number; blocked: number; failed: number; demo_readiness: string; voice_audio_note: string; scenes: SceneResult[] };

async function api(path: string, init?: RequestInit) {
  const token = localStorage.getItem("aivora.auth.token") || "";
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  const text = await res.text();
  let data: unknown = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data;
}
const color = (s: string) => (s === "PASS" ? "#0e6b57" : s === "FAIL" ? "#b42318" : "#b54708");

export function StoryboardView() {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => { api("/api/odai/storyboard/scenes").then((d) => setScenes((d as { scenes: Scene[] }).scenes || [])).catch((e) => setError(e.message)); }, []);

  async function runAll() {
    setBusy(true); setError(""); setActive(null); setRun(null);
    try {
      const rep = (await api("/api/odai/storyboard/run", { method: "POST", body: "{}" })) as Run;
      setRun(rep);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function runOne(n: number) {
    setBusy(true); setError(""); setActive(n);
    try {
      const s = (await api("/api/odai/storyboard/run", { method: "POST", body: JSON.stringify({ scene: n }) })) as SceneResult;
      setRun((prev) => {
        const scenesArr: SceneResult[] = prev ? prev.scenes.slice() : scenes.map((sc) => ({ scene: sc.n, title: sc.title, judge_sees: sc.judge_sees, status: "BLOCKED" as const, reason: "not run yet" }));
        const idx = scenesArr.findIndex((x) => x.scene === n);
        if (idx >= 0) scenesArr[idx] = s; else scenesArr.push(s);
        scenesArr.sort((a, b) => a.scene - b.scene);
        const passed = scenesArr.filter((x) => x.status === "PASS").length;
        const blocked = scenesArr.filter((x) => x.status === "BLOCKED").length;
        const failed = scenesArr.filter((x) => x.status === "FAIL").length;
        return { build: s ? "AIVORA ODAI V0.9BETA" : "", total: scenesArr.length, passed, blocked, failed, demo_readiness: failed ? "NOT READY — failures present" : "PARTIAL — run full storyboard for the ordered verdict", voice_audio_note: prev?.voice_audio_note || "", scenes: scenesArr };
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setActive(null); }
  }

  return (
    <div className="sb">
      <header className="sb-head">
        <h2>Competition Storyboard</h2>
        <p className="sb-sub">14 judge scenes in order · each runs the real backend and shows what the judge sees</p>
        <div className="sb-actions">
          <button className="btn-primary" disabled={busy} onClick={runAll}>{busy ? "Running…" : "▶ Run Full Storyboard"}</button>
        </div>
        {run && (
          <div className="sb-summary">
            <span style={{ color: "#0e6b57" }}>{run.passed} PASS</span>
            <span style={{ color: "#b42318" }}>{run.failed} FAIL</span>
            <span style={{ color: "#b54708" }}>{run.blocked} BLOCKED</span>
            <span className="sb-ready">{run.demo_readiness}</span>
          </div>
        )}
        {run?.voice_audio_note && <p className="sb-note">{run.voice_audio_note}</p>}
      </header>

      {error && <div className="sb-error">{error}</div>}

      <ol className="sb-list">
        {scenes.map((sc) => {
          const r = run?.scenes.find((x) => x.scene === sc.n);
          const isActive = active === sc.n;
          return (
            <li key={sc.n} className={`sb-scene${isActive ? " running" : ""}`}>
              <div className="sb-row">
                <span className="sb-num">{sc.n}</span>
                <div className="sb-main">
                  <b>{sc.title}</b>
                  <span className="sb-judge">Judge sees: {sc.judge_sees}</span>
                </div>
                {r && <span className="sb-status" style={{ background: color(r.status) }}>{r.status}</span>}
                <button className="btn-small" disabled={busy} onClick={() => runOne(sc.n)}>{isActive ? "…" : "Run"}</button>
                {r && <button className="btn-small" onClick={() => setOpen(open === sc.n ? null : sc.n)}>{open === sc.n ? "▲" : "▼"}</button>}
              </div>
              {r && open === sc.n && (
                <div className="sb-detail">
                  <div className="sb-observed">{r.observed || r.reason}</div>
                  {r.events && r.events.length > 0 && (
                    <div className="sb-exec">
                      {r.events.map((e) => (
                        <div key={e.step} className="sb-exec-line"><span className="sb-agent">{e.agent}</span> {e.line} <em>{e.status}</em></div>
                      ))}
                    </div>
                  )}
                  {r.audio_blocked && <div className="sb-audio">🔇 spoken audio needs mic + Model Studio key; engine/text path is real</div>}
                  <pre>{JSON.stringify(r.evidence, null, 2)}</pre>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
