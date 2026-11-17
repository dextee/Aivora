import { useEffect, useRef, useState } from "react";
import { openRealtime } from "./lib";

/* AIVORA real-time speech translation (qwen3.8-livetranslate-flash-realtime). */
type TRow = { src: string; out: string; stream?: boolean };

const FROM = [["auto", "Auto-detect 🌐"], ["yue", "廣東話 Cantonese"], ["nan", "福建話 Hokkien"], ["zh", "普通话 Mandarin"], ["en", "English"], ["ms", "Malay 🇲🇾"]] as const;
const TO = [["en", "English"], ["zh", "中文 Chinese"], ["yue", "廣東話 Cantonese"], ["ms", "Malay"], ["id", "Bahasa Indonesia"], ["th", "ไทย Thai"]] as const;
const NAME = Object.fromEntries([...FROM, ...TO]);

const DEMO: TRow[] = [
  { src: "林生你好，我哋下個月想加多兩成訂單。", out: "Hello Mr Lim — next month we want 20% more orders." },
  { src: "好嘢！咁我哋搞個促銷，定係加多啲廣告好？", out: "Great! So should we run a promotion, or buy more ads?" },
  { src: "推廣啦，預算有限，唔想僱多新人。", out: "A promotion — budget is limited and no new hires." },
];

export function TranslateView({ live }: { live: boolean }) {
  const [from, setFrom] = useState<string>("auto");
  const [to, setTo] = useState<string>("en");
  const [rows, setRows] = useState<TRow[]>([]);
  const [state, setState] = useState<"idle" | "listening" | "over">("idle");
  const engRef = useRef<ReturnType<typeof openRealtime> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveOut = useRef("");

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [rows, state]);
  useEffect(() => () => { try { engRef.current?.stop(); } catch { /* noop */ } }, []);

  async function holdStart() {
    if (state === "listening") return holdEnd();
    setState("listening");
    if (!live) { runDemo(); return; }
    const eng = openRealtime("translate", TO.some(([v]) => v === to) ? to : "en", (e) => {
      if (e.kind === "user") {
        liveOut.current = "";
        setRows((r) => [...r, { src: e.text, out: "", stream: true }]);
      } else if (e.kind === "translated") {
        liveOut.current += e.text;
        setRows((r) => {
          const copy = [...r]; const last = copy[copy.length - 1];
          if (last?.stream) copy[copy.length - 1] = { ...last, out: liveOut.current };
          else copy.push({ src: "", out: e.text });
          return copy;
        });
      } else if (e.kind === "reply") {
        setRows((r) => [...r, { src: "", out: e.text }]);
      } else if (e.kind === "error") setRows((r) => [...r, { src: "⚠ " + e.msg, out: "" }]);
      else if (e.kind === "closed") setState((s) => (s === "listening" ? s : "over"));
    });
    engRef.current = eng;
    try { await eng.startMic(); }
    catch { setRows((r) => [...r, { src: "⚠ Microphone permission needed", out: "" }]); setState("over"); }
  }
  function holdEnd() {
    try { engRef.current?.stop(); } catch { /* noop */ }
    engRef.current = null;
    setState("over");
    setRows((r) => r.map((x) => ({ ...x, stream: false })));
  }

  function runDemo() {
    let d = 700, i = 0;
    const step = () => {
      if (i >= DEMO.length) { setState("over"); return; }
      const row = DEMO[i++];
      setRows((r) => [...r, { ...row, out: "", stream: true }]);
      d += 1100;
      d && window.setTimeout(() => {
        setRows((r) => { const c = [...r]; c[c.length - 1] = { ...c[c.length - 1], out: row.out, stream: false }; return c; });
        window.setTimeout(step, 900);
      }, d - 600);
    };
    window.setTimeout(step, 400);
  }

  return (
    <>
      <div className="pillbar">
        <span style={{ font: "800 10.5px var(--font)", color: "var(--ink2)", alignSelf: "center", letterSpacing: ".06em" }}>FROM</span>
        <select className="lpill sel" value={from} onChange={(e) => setFrom(e.target.value)} style={{ appearance: "auto" }}>
          {FROM.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="swapbtn" aria-label="Swap languages" onClick={() => {
          if (FROM.some(([v]) => v === to)) { setTo(from === "auto" ? "en" : from); setFrom(to); }
        }}>⇅</button>
        <span style={{ font: "800 10.5px var(--font)", color: "var(--ink2)", alignSelf: "center", letterSpacing: ".06em" }}>TO</span>
        <select className="lpill sel" value={to} onChange={(e) => setTo(e.target.value)} style={{ appearance: "auto" }}>
          {TO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      <div className="conv" ref={scrollRef}>
        {rows.length === 0 && state !== "listening" && (
          <div style={{ textAlign: "center", padding: "44px 22px", color: "var(--ink2)" }}>
            <div style={{ fontSize: 44, marginBottom: 10 }}>🗣️‍➡️</div>
            <h3 style={{ font: "800 18px var(--display)", color: "var(--wa-teal)" }}>Live Interpreter</h3>
            <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 6 }}>
              Hold the mic and speak naturally — {NAME[from] ?? "any language"} turns into {NAME[to] ?? to}:
              translated captions + spoken voice, in real time. Great for supplier calls and family meetings.
            </p>
            {!live && <p style={{ fontSize: 11.5, marginTop: 8 }}>Demo mode plays a sample 廣東話→English exchange.</p>}
          </div>
        )}
        {!live && rows.length > 0 && <div className="daychip">DEMO TRANSLATION SESSION</div>}
        {rows.map((r, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            {r.src && <div style={{ margin: "0 0 4px auto", width: "fit-content", maxWidth: "86%" }} className="bub" >
              <span className="chip2 src">{NAME[from] ?? (from === "auto" ? "detected" : from)}</span>
              <div className="btxt">{r.src}</div>
            </div>}
            <div className="bub" style={{ maxWidth: "86%" }}>
              <span className="chip2">→ {NAME[to] ?? to}</span>
              <div className="btxt" style={{ fontSize: 14.5, fontWeight: 600 }}>{r.out || (r.stream ? "…" : "")}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="ctlbar">
        <div className={`spk${state === "listening" ? " rec" : ""}`}>
          <span className="lbl">{state === "listening"
            ? (live ? "● Listening — speak now, tap ■ when done" : "● Demo translating…")
            : rows.length ? "Session ended — tap mic for another" : "Tap the mic to start interpreting"}</span>
          {state === "listening" && !live && <button className="mab" style={{ flex: "0 0 auto", padding: "8px 12px" }} onClick={() => { setState("idle"); }}>■</button>}
        </div>
        <button className={`mic-round${state === "listening" ? " on" : ""}`} onClick={holdStart} aria-label="Toggle interpreter mic">
          {state === "listening" ? "■" : "🎙"}
        </button>
      </div>
    </>
  );
}
