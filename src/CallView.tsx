import { useEffect, useRef, useState } from "react";
import { openRealtime, type LiveEvent } from "./lib";

/* AIVORA Live Call — omni-realtime voice; demo mode replays a scripted call. */
type Row = { who: "me" | "ai" | "sys" | "err" | "log"; text?: string; wav?: number[]; log?: Record<string, unknown> };

const DEMO: Row[] = [
  { who: "sys", text: "🔗 Connecting to AIVORA (demo — no key configured)" },
  { who: "me", text: "Hello ah — I want to grow sales 30% in the next 90 days.", wav: [4, 6, 9, 5, 8, 12, 7, 10, 6, 9] },
  { who: "ai", text: "Got it. +30% revenue in 90 days. Fastest path with your current budget — fix online checkout, launch promos, reach customers by email?" },
  { who: "me", text: "Yes, but do not spend extra budget.", wav: [5, 8, 6, 9, 7, 5, 8, 6] },
  { who: "ai", text: "Understood - zero extra spend. I will prepare drafts for your approval only." },
  { who: "log", log: { summary: "Objective captured", growth_pct: 30, horizon_days: 90, language: "Hokkien-flavoured English", action_items: ["Set up online store promotions", "Email campaign to past customers", "15-sec promo video — drafts for approval"] } },
  { who: "sys", text: "📞 Call ended · summary saved to log" },
];

export function CallView({ live }: { live: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"idle" | "connecting" | "on" | "over">("idle");
  const [secs, setSecs] = useState(0);
  const [muted, setMuted] = useState(false);
  const engRef = useRef<ReturnType<typeof openRealtime> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const demoTimers = useRef<number[]>([]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [rows, state]);

  useEffect(() => () => stop(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state !== "on") return;
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  function stop(silent = false) {
    try { engRef.current?.stop(); } catch { /* noop */ }
    engRef.current = null;
    demoTimers.current.forEach((t) => window.clearTimeout(t));
    demoTimers.current = [];
    if (!silent) setState("over");
  }

  async function start() {
    setRows([]); setSecs(0); setState("connecting");
    if (!live) return runDemo();
    const eng = openRealtime("omni", "en", (e: LiveEvent) => {
      switch (e.kind) {
        case "ready": setState("on"); setRows((r) => [...r, { who: "sys", text: "🔗 Live — speak Hokkien, Cantonese or English. AIVORA answers by voice." }]); break;
        case "user": setRows((r) => [...r, { who: "me", text: e.text }]); break;
        case "reply": setRows((r) => [...r, { who: "ai", text: e.text }]); break;
        case "objective": setRows((r) => [...r, { who: "log", log: e.data }]); break;
        case "error": setRows((r) => [...r, { who: "err", text: e.msg }]); break;
        case "closed": setState((s) => (s === "idle" || s === "connecting" ? "idle" : "over")); break;
      }
    });
    engRef.current = eng;
    try {
      await eng.startMic();
    } catch {
      setRows((r) => [...r, { who: "err", text: "Microphone permission needed for live call." }]);
      stop();
    }
  }

  function runDemo() {
    let delay = 500;
    DEMO.forEach((row) => {
      const t = window.setTimeout(() => {
        setRows((r) => [...r, row]);
        if (row.who === "sys" && row.text?.includes("Connecting")) setState("on");
        if (row.who === "sys" && row.text?.includes("ended")) setState("over");
      }, delay);
      demoTimers.current.push(t);
      delay += (row.wav ? 1400 : row.who === "log" ? 1200 : 900) + Math.random() * 600;
    });
  }

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <>
      <div className="conv" ref={scrollRef}>
        {rows.length === 0 && state === "idle" && (
          <div style={{ textAlign: "center", padding: "48px 22px", color: "var(--ink2)" }}>
            <img src="/logo.png" alt="" style={{ width: 92, height: 92, borderRadius: 28, marginBottom: 16, boxShadow: "0 8px 24px -6px rgba(7,94,84,.4)" }} />
            <h3 style={{ font: "800 19px var(--display)", color: "var(--wa-teal)" }}>AIVORA Live Call</h3>
            <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
              Talk your business goals in <b>Hokkien 福建話, 廣東話 Cantonese</b>, Mandarin or English.
              AIVORA answers by voice and logs the objective + action items.
            </p>
            {!live && <p style={{ fontSize: 11.5, marginTop: 10 }}>No key yet → “Start call” plays a scripted demo call.</p>}
          </div>
        )}
        {state !== "idle" && <div className="daychip">{state === "on" ? `● Call connected — ${fmt(secs)}` : state === "connecting" ? "Calling AIVORA…" : `Call ended — ${fmt(secs)}`}</div>}
        {rows.map((r, i) => (
          <div key={i} className={`bubrow${r.who === "me" ? " me" : ""}`}>
            {r.who === "sys" || r.who === "err"
              ? <div className={`bub ${r.who === "err" ? "err" : "sys"}`}>{r.text}</div>
              : r.who === "log" ? <LogCard log={r.log as Record<string, unknown>} />
                : <div className="bub">
                    <span className="tag">{r.who === "me" ? "You" : "AIVORA"}</span>
                    {r.wav && <div className="wav">{r.wav.map((h, j) => <i key={j} style={{ height: `${h * 2}px` }} />)}</div>}
                    <div className="btxt">{r.text}</div><time>{fmt(secs)}</time>
                  </div>}
          </div>
        ))}
      </div>
      <div className="callbar">
        {state === "idle" || state === "over" ? (
          <button className="cb-ico" style={{ width: 62, height: 62, borderRadius: "50%", background: "var(--wa-green)", color: "#06331f", fontSize: 24 }} onClick={start} aria-label="Start call">📞</button>
        ) : (
          <>
            <button className={`cb-ico${muted ? " on" : ""}`} onClick={() => { const m = !muted; setMuted(m); engRef.current?.setMuted(m); }} aria-label="Mute">{muted ? "🔇" : "🎙"}</button>
            <span style={{ alignSelf: "center", font: "700 12px var(--display)", color: muteColor(state), letterSpacing: ".06em" }}>{!live ? "DEMO" : state === "connecting" ? "DIALING" : "LIVE"} · {fmt(secs)}</span>
            <button className="cb-ico end" onClick={() => { stop(); }} aria-label="End call">✕</button>
          </>
        )}
      </div>
    </>
  );
}
const muteColor = (s: string) => (s === "on" ? "var(--wa-green)" : "var(--ink2)");

function LogCard({ log }: { log: Record<string, unknown> }) {
  const items = Array.isArray(log.action_items) ? (log.action_items as string[]) : [];
  return (
    <div className="bub cardlog">
      <h5>📋 CALL LOG — OBJECTIVE CAPTURED</h5>
      {typeof log.summary === "string" && <p style={{ fontSize: 13 }}>{log.summary}</p>}
      <div className="kvs">
        <div><label>Target</label><b>{typeof log.growth_pct === "number" ? `+${log.growth_pct}%` : "—"}</b></div>
        <div><label>Horizon</label><b>{typeof log.horizon_days === "number" ? `${log.horizon_days} days` : "—"}</b></div>
        <div><label>Language</label><b style={{ fontSize: 12 }}>{String(log.language ?? "auto")}</b></div>
        <div><label>Status</label><b style={{ fontSize: 12, color: "var(--wa-green)" }}>Logged ✓</b></div>
      </div>
      {items.length > 0 && <ul>{items.map((a, i) => <li key={i}>{a}</li>)}</ul>}
    </div>
  );
}
