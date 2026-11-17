import { useEffect, useRef, useState } from "react";
import { openRealtimeRtc, type RtcHandle } from "./rtc";
import type { LiveEvent } from "./lib";

/* Talk to AIVORA — one big green button. The model itself routes:
 * conversation stays on qwen3.8-omni-flash-realtime; when the user asks to
 * interpret speech, the model calls start_interpreter
 * (→ qwen3.8-livetranslate-flash-realtime); for papers it calls
 * open_document_translator (→ qwen3.8-omni-flash on the Docs screen); goals
 * arrive as log_call cards. */

type Row =
  | { who: "me" | "ai" | "sys" | "err"; text: string }
  | { who: "pair"; src: string; out: string }
  | { who: "log"; log: Record<string, unknown> };

const LNAME: Record<string, string> = { en: "English", zh: "中文", yue: "廣東話", ms: "Malay", id: "Bahasa Indonesia", th: "ไทย", ta: "தமிழ்" };

export function TalkView({ onOpenDocs }: { onOpenDocs(): void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"idle" | "connecting" | "partner" | "interpreter">("idle");
  const [target, setTarget] = useState("en");
  const [secs, setSecs] = useState(0);
  const engRef = useRef<RtcHandle | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const outBuf = useRef("");
  const pairOpen = useRef(false);

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [rows, state]);
  useEffect(() => () => { try { engRef.current?.stop(); } catch { /* unmount */ } }, []);
  useEffect(() => {
    if (state !== "partner" && state !== "interpreter") return;
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const isOn = state === "partner" || state === "interpreter";
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  function connect(mode: "omni" | "translate") {
    setState("connecting"); setSecs(0);
    const eng = openRealtimeRtc(mode, target, (e: LiveEvent) => {
      switch (e.kind) {
        case "ready": setState(mode === "translate" ? "interpreter" : "partner"); break;
        case "user":
          if (mode === "translate") { outBuf.current = ""; pairOpen.current = true; setRows((r) => [...r, { who: "pair", src: e.text, out: "" }]); }
          else setRows((r) => [...r, { who: "me", text: e.text }]);
          break;
        case "reply": setRows((r) => [...r, { who: "ai", text: e.text }]); break;
        case "translated": {
          const d = e.text;
          setRows((r) => {
            const c = [...r]; const last = c[c.length - 1];
            if (pairOpen.current && last && last.who === "pair") c[c.length - 1] = { ...last, out: (last.out || "") + d };
            else c.push({ who: "pair", src: "", out: d });
            return c;
          });
          break;
        }
        case "objective":
          setRows((r) => [...r, { who: "log", log: e.data },
            { who: "ai", text: "✓ Logged. Working the plan — reply here or open Document Translation for papers." }]);
          break;
        case "interpret": {
          const tg = LNAME[e.target] ? e.target : "en";
          setTarget(tg);
          setRows((r) => [...r, { who: "sys", text: `🎧 Interpreter engaged → ${LNAME[tg] ?? tg}. Speak; AIVORA voices the translation. Press the button to stop.` }]);
          try { engRef.current?.stop(); } catch { /* swap */ }
          window.setTimeout(() => connect("translate"), 350);
          break;
        }
        case "route_docs":
          setRows((r) => [...r, { who: "sys", text: "📄 Opening Document Translation…" }]);
          try { engRef.current?.stop(); } catch { /* handoff */ }
          setState("idle");
          window.setTimeout(onOpenDocs, 500);
          break;
        case "error": setRows((r) => [...r, { who: "err", text: e.msg }]); setState("idle"); break;
        case "closed": setState((s) => (s === "connecting" || s === "idle" ? "idle" : s)); break;
      }
    });
    engRef.current = eng;
  }

  function press() {
    if (isOn || state === "connecting") {
      try { engRef.current?.stop(); } catch { /* noop */ }
      engRef.current = null;
      pairOpen.current = false;
      setState("idle");
      setRows((r) => [...r, { who: "sys", text: state === "interpreter" ? "🎧 Interpreter stopped — back anytime, just press and ask." : "👋 Ready when you are." }]);
      return;
    }
    connect("omni");
  }

  return (
    <div className="view talkview">
      <div className="conv talkfeed" ref={feedRef}>
        {rows.length === 0 && (
          <div className="talk-hero">
            <img src="/logo.png" alt="AIVORA" />
            <h2>Talk to AIVORA</h2>
            <p>One press. Speak naturally — <b>福建話 · 廣東話 ·普通话 · English</b>.<br />
              Ask for goals, interpretation or a document — AIVORA routes itself.</p>
            <span className="tryline">try: “帮我，我想90工赞加三成生意” · “interpret for my supplier” · “translate this contract”</span>
          </div>
        )}
        {rows.map((r, i) => (
          <div key={i} className={`bubrow${r.who === "me" ? " me" : ""}`}>
            {r.who === "sys" || r.who === "err"
              ? <div className={`bub ${r.who === "err" ? "err" : "sys"}`}>{r.text}</div>
              : r.who === "log" ? <LogCard log={r.log} />
              : r.who === "pair" ? (
                <div style={{ maxWidth: "88%" }}>
                  {r.src && <div className="bub pair-src"><span className="chip2 src">heard</span><div className="btxt">{r.src}</div></div>}
                  <div className="bub" style={{ marginTop: r.src ? 4 : 0 }}><span className="chip2">→ {LNAME[target] ?? target}</span>
                    <div className="btxt" style={{ fontWeight: 600 }}>{r.out || "…"}</div></div>
                </div>
              )
              : <div className="bub"><span className="tag">{r.who === "me" ? "You" : "AIVORA"}</span>
                  <div className="btxt">{r.text}</div><time>{fmt(secs)}</time></div>}
          </div>
        ))}
      </div>

      <div className="talk-ctl">
        <div className={`talk-status${isOn ? " on" : ""}`}>
          {state === "connecting" ? "connecting…"
            : state === "partner" ? `● live · ${fmt(secs)} · press to end`
            : state === "interpreter" ? `🎧 interpreting → ${LNAME[target] ?? target} · press to stop`
            : "press to talk"}
        </div>
        <button className={`big-mic${isOn ? " on" : ""}${state === "connecting" ? " wait" : ""}`} onClick={press}
          aria-label={isOn ? "Stop talking to AIVORA" : "Talk to AIVORA"}>
          {state === "connecting"
            ? <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".9s" repeatCount="indefinite" /></path></svg>
            : isOn
              ? <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" /></svg>
              : <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor" /><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>}
        </button>
      </div>
    </div>
  );
}

function LogCard({ log }: { log: Record<string, unknown> }) {
  const items = Array.isArray(log.action_items) ? (log.action_items as string[]) : [];
  return (
    <div className="bub cardlog">
      <h5>📋 OBJECTIVE CAPTURED</h5>
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
