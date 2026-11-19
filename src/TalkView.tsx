import { useEffect, useRef, useState } from "react";
import { openRealtimeRtc, type RtcHandle } from "./rtc";
import { asrTranscribe, blobsToWav, fileToDataUrl, talkReply, type LiveEvent } from "./lib";

/* Talk to AIVORA — one big green button.
 * turn = record → silence-trimmed 16 kHz WAV → qwen-audio-3.1-asr-flash (Minnan ear)
 *      → routeTranscript: docs? interpreter? goal card? → /api/talk
 *      (server opens qwen-audio-3.1-realtime-flash WS, returns spoken reply +
 *      transcript + optional log_call) → VoiceReply plays 24 kHz PCM through a
 *      gesture-unlocked AudioContext. No browser WebRTC on the reply path.
 * Interpreter mode remains continuous WebRTC (that genuinely needs it). */

type Row =
  | { who: "me" | "ai" | "sys" | "err"; text: string }
  | { who: "pair"; src: string; out: string }
  | { who: "log"; log: Record<string, unknown> };
type S = "idle" | "recording" | "processing" | "interpreter";

const LNAME: Record<string, string> = { en: "English", zh: "中文", yue: "廣東話", ms: "Malay", id: "Bahasa Indonesia", th: "ไทย", ta: "தமிழ்" };
const CN_NUM: Record<string, number> = { 一: 10, 两: 20, 二: 20, 三: 30, 四: 40, 五: 50, 六: 60, 七: 70, 八: 80, 九: 90, 十: 100 };

export function TalkView({ onOpenDocs }: { onOpenDocs(): void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<S>("idle");
  const [target, setTarget] = useState("en");
  const [secs, setSecs] = useState(0);
  const interpRef = useRef<RtcHandle | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const recStream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recTimer = useRef<number | null>(null);
  const clockTimer = useRef<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const outBuf = useRef("");
  const objectiveDone = useRef(false);
  const stateRef = useRef<S>("idle");
  stateRef.current = state;

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [rows, state]);
  useEffect(() => () => hangUp(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  function clock(on: boolean) {
    if (clockTimer.current) window.clearInterval(clockTimer.current);
    if (on) clockTimer.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
  }

  /* ---------- audio output (unlocked by the press gesture) ---------- */
  function ensureCtx() {
    if (!ctxRef.current) ctxRef.current = new AudioContext({ sampleRate: 24000 });
    void ctxRef.current.resume().catch(() => undefined);
  }
  function speak(pcm: Uint8Array) {
    const ctx = ctxRef.current; if (!ctx || !pcm.length) return;
    const buf = ctx.createBuffer(1, Math.floor(pcm.length / 2), 24000);
    const ch = buf.getChannelData(0);
    const i16 = new Int16Array(pcm.buffer.slice(0, pcm.byteLength) as ArrayBuffer);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 0x8000;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
  }

  /* ---------- interpreter (continuous WebRTC — lives here only) ---------- */
  function startInterpreter(tg: string) {
    stopRecorderEverything();
    setTarget(tg); setState("interpreter"); setSecs(0); clock(true);
    outBuf.current = "";
    const eng = openRealtimeRtc("translate", tg, (e: LiveEvent) => {
      if (e.kind === "user") { outBuf.current = ""; setRows((r) => [...r, { who: "pair", src: e.text, out: "" }]); }
      else if (e.kind === "translated") {
        setRows((r) => { const c = [...r]; const last = c[c.length - 1];
          if (last?.who === "pair") c[c.length - 1] = { ...last, out: last.out + e.text }; else c.push({ who: "pair", src: "", out: e.text });
          return c; });
      }
      else if (e.kind === "error") setRows((r) => [...r, { who: "err", text: e.msg }]);
      else if (e.kind === "closed" && stateRef.current === "interpreter") setState("idle");
    });
    interpRef.current = eng;
  }

  function stopRecorderEverything() {
    if (recTimer.current) window.clearInterval(recTimer.current);
    try { if (recRef.current?.state === "recording") recRef.current.stop(); } catch { /* noop */ }
    recStream.current?.getTracks().forEach((t) => t.stop()); recStream.current = null;
  }

  function hangUp(silent = false) {
    stopRecorderEverything();
    try { interpRef.current?.stop(); } catch { /* noop */ }
    interpRef.current = null;
    clock(false); setSecs(0); setState("idle");
    if (!silent) setRows((r) => [...r, { who: "sys", text: "👋 Ready when you are." }]);
  }

  /* ---------- turn capture ---------- */
  async function beginTurn() {
    ensureCtx(); // mic permission gesture also unlocks audio output
    objectiveDone.current = false; setSecs(0);
    try {
      recStream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch { setRows((r) => [...r, { who: "err", text: "microphone permission needed" }]); return; }
    chunks.current = [];
    const rec = new MediaRecorder(recStream.current);
    rec.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
    rec.onstop = voidTurn;
    rec.start();
    recRef.current = rec;
    setState("recording"); clock(true);
    if (!rows.length) setRows((r) => [...r, { who: "sys", text: "🎙 Listening — 用闽南话讲都未惊 · tap the button when you finish." }]);
    let n = 0;
    if (recTimer.current) window.clearInterval(recTimer.current);
    recTimer.current = window.setInterval(() => { if (++n > 45) finishTurn(); }, 1000);
  }

  function finishTurn() {
    if (recTimer.current) window.clearInterval(recTimer.current);
    try { recRef.current?.state === "recording" && recRef.current.stop(); } catch { /* noop */ }
    recStream.current?.getTracks().forEach((t) => t.stop()); recStream.current = null;
    clock(false); setState("processing");
  }

  async function voidTurn() {
    try {
      if (!chunks.current.length) { setState("idle"); return; }
      const wav = await blobsToWav(chunks.current);
      if (wav.size < 6_000) { setRows((r) => [...r, { who: "sys", text: "⏱ Too short — try again." }]); setState("idle"); return; }
      const url = await fileToDataUrl(wav);
      const text = await asrTranscribe(url);
      setRows((r) => [...r, { who: "me", text }]);
      await routeTranscript(text);
    } catch (e) {
      setRows((r) => [...r, { who: "err", text: e instanceof Error ? e.message : String(e) }]);
    } finally { setState((s) => (s === "interpreter" ? s : "idle")); }
  }

  /* ---------- router ---------- */
  function parseGoal(text: string): { pct: number; days: number } | null {
    let pct = +(text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|pc)/i)?.[1] ?? 0);
    if (!pct) {
      const cheng = text.match(/([一两二三四五六七八九十])成/)?.[1];
      if (cheng) pct = CN_NUM[cheng] ?? 0;
      const bfb = text.match(/百分之([一二两三四五六七八九十\d]+)/);
      if (bfb) pct = (CN_NUM[bfb[1]] ?? +bfb[1]) || pct;
    }
    let days = +(text.match(/(\d+)\s*(?:天|工|日|days?)/i)?.[1] ?? 0);
    if (!days) { const m = text.match(/(\d+)\s*(?:个?月|months?)/i); if (m) days = +m[1] * 30; }
    return pct && days ? { pct, days } : null;
  }

  async function routeTranscript(text: string) {
    if (/document|contract|photo|invoice|paper|letter|文件|合同|合約|单据|單據|照片/.test(text) && /translat|翻译|翻譯|convert/i.test(text)) {
      setState("idle");
      setRows((r) => [...r, { who: "sys", text: "📄 Opening Document Translation…" }]);
      window.setTimeout(onOpenDocs, 400);
      return;
    }
    if (/interpret(er)?\b|替我翻译|帮我翻译|live.{0,10}translat|帮我跟客户/i.test(text) && !/document|contract|photo/i.test(text)) {
      const tg = /廣東話|cantonese|粤/i.test(text) ? "yue" : /英文|english/i.test(text) ? "en"
        : /中文|普通话|mandarin|chinese|华文/.test(text) ? "zh" : /马来|malay|melayu/.test(text) ? "ms"
        : /泰|thai/.test(text) ? "th" : /印尼|indonesia|bahasa/.test(text) ? "id" : "en";
      setRows((r) => [...r, { who: "sys", text: `🎧 Interpreter on → ${LNAME[tg]}. Speak freely; tap the button to stop.` }]);
      startInterpreter(tg);
      return;
    }
    if (objectiveDone.current) return;
    const g = parseGoal(text);
    if (g) {
      objectiveDone.current = true;
      setRows((r) => [...r, { who: "log", log: { summary: "Objective captured from your voice", growth_pct: g.pct, horizon_days: g.days, language: "Minnan/Hokkien via ASR" } }]);
    }
    const res = await talkReply(text);
    const tl = res.tool as Record<string, unknown> | null;
    if (tl && !objectiveDone.current) {
      objectiveDone.current = true;
      setRows((r) => [...r, { who: "log", log: tl }]);
    }
    if (!objectiveDone.current && g) objectiveDone.current = true;
    setRows((r) => [...r, { who: "ai", text: res.text || "…" }]);
    if (res.audio) speak(res.audio);
    else if (res.text) setRows((r) => [...r, { who: "sys", text: "🔇 voice came back empty — text reply only" }]);
  }

  /* ---------- the single button ---------- */
  function press() {
    switch (state) {
      case "idle": void beginTurn(); break;
      case "recording": finishTurn(); break;
      case "processing": break;
      case "interpreter":
        try { interpRef.current?.stop(); } catch { /* noop */ }
        interpRef.current = null; clock(false); setState("idle");
        setRows((r) => [...r, { who: "sys", text: "🎧 Interpreter stopped. Tap to talk to AIVORA again." }]);
        break;
    }
  }

  const label =
    state === "recording" ? "● recording · tap to send"
    : state === "processing" ? "transcribing + composing voice reply…"
    : state === "interpreter" ? `🎧 interpreting → ${LNAME[target]} · tap to stop`
    : rows.length ? "tap to talk to AIVORA again"
    : "press to talk to AIVORA";

  return (
    <div className="view talkview">
      <div className="conv talkfeed" ref={feedRef}>
        {rows.length === 0 && state === "idle" && (
          <div className="talk-hero">
            <img src="/logo.png" alt="AIVORA" />
            <h2>Talk to AIVORA</h2>
            <p>One press. Speak <b>闽南话 Hokkien · 廣東話 · 普通话 · English</b>.<br />
              A Min-Nan specialist hears you; AIVORA answers out loud.</p>
            <span className="tryline">try: “帮我，我想90工赞加三成生意” · “帮我跟客户翻译” · “translate this contract”</span>
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
              : <div className="bub"><span className="tag">{r.who === "me" ? "You · Minnan ASR" : "AIVORA"}</span>
                  <div className="btxt">{r.text}</div><time>{`${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`}</time></div>}
          </div>
        ))}
      </div>

      <div className="talk-ctl">
        <div className={`talk-status${state !== "idle" ? " on" : ""}`}>{label}</div>
        <button className={`big-mic${state === "recording" || state === "interpreter" ? " on" : ""}${state === "processing" ? " wait" : ""}`}
          onClick={press} aria-label="Talk to AIVORA">
          {state === "processing"
            ? <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".9s" repeatCount="indefinite" /></path></svg>
            : state === "recording" || state === "interpreter"
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
        <div><label>Heard via</label><b style={{ fontSize: 12 }}>{String(log.language ?? "Minnan ASR")}</b></div>
        <div><label>Status</label><b style={{ fontSize: 12, color: "var(--wa-green)" }}>Logged ✓</b></div>
      </div>
      {items.length > 0 && <ul>{items.map((a, i) => <li key={i}>{a}</li>)}</ul>}
    </div>
  );
}
