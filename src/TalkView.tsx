import { useEffect, useRef, useState } from "react";
import { openRealtimeRtc, type RtcHandle } from "./rtc";
import { asrTranscribe, blobsToWav, fileToDataUrl, type LiveEvent } from "./lib";

/* Talk to AIVORA — one big green button, two-stage Min-Nan ear:
 *   press → record your turn (local 16 kHz WAV)
 *   press → qwen-audio-3.1-asr-flash transcribes (Hokkien/Minnan specialist)
 *           transcript bubble is what the system "heard" — then the text turn
 *           goes to qwen-audio-3.1-realtime-flash (voice reply) and the
 *           router (tools or keywords) engages interpreter / documents /
 *           objective cards. Hold 0.5 s = hang up. */

type Row =
  | { who: "me" | "ai" | "sys" | "err"; text: string }
  | { who: "pair"; src: string; out: string }
  | { who: "log"; log: Record<string, unknown> };
type S = "idle" | "recording" | "processing" | "partner" | "interpreter";

const LNAME: Record<string, string> = { en: "English", zh: "中文", yue: "廣東話", ms: "Malay", id: "Bahasa Indonesia", th: "ไทย", ta: "தமிழ்" };
const CN_NUM: Record<string, number> = { 一: 10, 两: 20, 二: 20, 三: 30, 四: 40, 五: 50, 六: 60, 七: 70, 八: 80, 九: 90, 十: 100 };

export function TalkView({ onOpenDocs }: { onOpenDocs(): void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<S>("idle");
  const [target, setTarget] = useState("en");
  const [secs, setSecs] = useState(0);
  const partnerRef = useRef<RtcHandle | null>(null);
  const interpRef = useRef<RtcHandle | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const recStream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recTimer = useRef<number | null>(null);
  const clockTimer = useRef<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const outBuf = useRef("");
  const objectiveDone = useRef(false);
  const toollessRef = useRef(false);
  const downAt = useRef(0);
  const stateRef = useRef<S>("idle");
  stateRef.current = state;

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [rows, state]);
  useEffect(() => () => hangUp(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  function clock(on: boolean) {
    if (clockTimer.current) window.clearInterval(clockTimer.current);
    if (!on) return;
    clockTimer.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
  }

  /* ---------- partner session (voice reply brain, ears off — ASR feeds text) ---------- */
  function ensurePartner(): RtcHandle {
    if (partnerRef.current) return partnerRef.current;
    const eng = openRealtimeRtc("omni", "en", partnerEvent, { mutedInput: true });
    partnerRef.current = eng;
    return eng;
  }

  function partnerEvent(e: LiveEvent) {
    switch (e.kind) {
      case "reply": setRows((r) => [...r, { who: "ai", text: e.text }]); break;
      case "objective":
        if (!objectiveDone.current) { objectiveDone.current = true; setRows((r) => [...r, { who: "log", log: e.data }]); }
        break;
      case "interpret": {
        const tg = LNAME[e.target] ? e.target : "en";
        setTarget(tg);
        setRows((r) => [...r, { who: "sys", text: `🎧 Interpreter engaged → ${LNAME[tg]} (Minnan-tuned ears stay on for you). Press the button when done.` }]);
        stopPartner();
        window.setTimeout(() => startInterpreter(tg), 350);
        break;
      }
      case "route_docs":
        setRows((r) => [...r, { who: "sys", text: "📄 Opening Document Translation…" }]);
        stopPartner(); setState("idle");
        window.setTimeout(onOpenDocs, 400);
        break;
      case "error":
        if (e.msg.includes("routing tools rejected")) {
          toollessRef.current = true;
          setRows((r) => [...r, { who: "sys", text: "ℹ️ Base voice config active — keywords still route." }]);
          break;
        }
        setRows((r) => [...r, { who: "err", text: e.msg }]);
        break;
      case "closed":
        partnerRef.current = null;
        if (stateRef.current === "partner") { setState("idle"); }
        break;
    }
  }

  function stopPartner() {
    try { partnerRef.current?.stop(); } catch { /* noop */ }
    partnerRef.current = null;
  }

  /* ---------- interpreter (continuous, its own ears via WebRTC track) ---------- */
  function startInterpreter(tg: string) {
    setState("interpreter"); setSecs(0); clock(true);
    pairOpenEars(tg);
  }
  function pairOpenEars(tg: string) {
    outBuf.current = "";
    const eng = openRealtimeRtc("translate", tg, (e) => {
      if (e.kind === "user") { outBuf.current = ""; setRows((r) => [...r, { who: "pair", src: e.text, out: "" }]); }
      else if (e.kind === "translated") {
        outBuf.current += e.text;
        setRows((r) => { const c = [...r]; const last = c[c.length - 1];
          if (last?.who === "pair") c[c.length - 1] = { ...last, out: last.out + e.text }; else c.push({ who: "pair", src: "", out: e.text });
          return c; });
      }
      else if (e.kind === "error") setRows((r) => [...r, { who: "err", text: e.msg }]);
      else if (e.kind === "closed" && stateRef.current === "interpreter") setState("idle");
    });
    interpRef.current = eng;
  }

  function hangUp(silent = false) {
    if (recTimer.current) window.clearInterval(recTimer.current);
    try { if (recRef.current?.state === "recording") recRef.current.stop(); } catch { /* noop */ }
    recStream.current?.getTracks().forEach((t) => t.stop()); recStream.current = null;
    stopPartner();
    try { interpRef.current?.stop(); } catch { /* noop */ }
    interpRef.current = null;
    clock(false); setSecs(0);
    setState("idle");
    if (!silent) setRows((r) => [...r, { who: "sys", text: "👋 Ready when you are." }]);
  }

  /* ---------- turn capture ---------- */
  async function beginTurn() {
    setRows((r) => (r.length ? r : r)); setSecs(0); objectiveDone.current = false;
    const fresh = stateRef.current === "idle";
    if (fresh) ensurePartner(); // start dialing the reply brain while user speaks
    try {
      recStream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setRows((r) => [...r, { who: "err", text: "microphone permission needed" }]);
      if (fresh) stopPartner();
      return;
    }
    chunks.current = [];
    const rec = new MediaRecorder(recStream.current);
    rec.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
    rec.onstop = voidTurn;
    rec.start();
    recRef.current = rec;
    setState("recording"); clock(true);
    if (fresh) setRows((r) => [...r, { who: "sys", text: "🎙 Listening — 用闽南话讲都未惊，press the button when you finish." }]);
    let n = 0;
    if (recTimer.current) window.clearInterval(recTimer.current);
    recTimer.current = window.setInterval(() => { if (++n > 60) finishTurn(); }, 1000);
    if (stateRef.current !== "partner") setState("recording");
  }

  function finishTurn() {
    if (recTimer.current) window.clearInterval(recTimer.current);
    try { recRef.current?.state === "recording" && recRef.current.stop(); } catch { /* noop */ }
    recStream.current?.getTracks().forEach((t) => t.stop()); recStream.current = null;
    clock(false);
    setState("processing");
  }

  async function voidTurn() {
    try {
      if (!chunks.current.length) { setState(stateRef.current === "processing" ? "idle" : "partner"); return; }
      const wav = await blobsToWav(chunks.current);
      if (wav.size < 4_000) { setRows((r) => [...r, { who: "sys", text: "⏱ That was too short — try again." }]); setState(partnerRef.current ? "partner" : "idle"); return; }
      const url = await fileToDataUrl(wav);
      const text = await asrTranscribe(url);
      setRows((r) => [...r, { who: "me", text }]);
      routeTranscript(text);
    } catch (e) {
      setRows((r) => [...r, { who: "err", text: e instanceof Error ? e.message : String(e) }]);
      setState(partnerRef.current ? "partner" : "idle");
    }
  }

  /* ---------- router: goals → card, interpreter/docs docs, else reply brain ---------- */
  function parseGoal(text: string): { pct: number; days: number } | null {
    let pct = +(text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|pc)/i)?.[1] ?? 0);
    if (!pct) {
      const cheng = text.match(/([一两二三四五六七八九十])成/)?.[1];
      if (cheng) pct = CN_NUM[cheng] ?? 0;
      const bfb = text.match(/百分之([一二两二三四五六七八九十\d]+)/);
      if (bfb) pct = (CN_NUM[bfb[1]] ?? +bfb[1]) || pct;
    }
    let days = +(text.match(/(\d+)\s*(?:天|工|日|days?)/i)?.[1] ?? 0);
    if (!days) { const m = text.match(/(\d+)\s*(?:个?月|months?)/i); if (m) days = +m[1] * 30; }
    if (!days && /两个半月|两个半月/.test(text)) days = 75;
    return pct && days ? { pct, days } : null;
  }

  function routeTranscript(text: string) {
    if (/document|contract|photo|invoice|paper|letter|文件|合同|合約|单据|單據|照片/.test(text) && /translat|翻译|翻譯|convert/i.test(text)) {
      setRows((r) => [...r, { who: "sys", text: "📄 Opening Document Translation…" }]);
      stopPartner(); setState("idle");
      window.setTimeout(onOpenDocs, 400);
      return;
    }
    if (/interpret(er)?\b|替我翻译|帮我翻译.(话|对白|conversation)|live.{0,10}translat/i.test(text) && !/document|contract|photo/i.test(text)) {
      const tg = /廣東話|cantonese|粤/i.test(text) ? "yue" : /英文|english/i.test(text) ? "en"
        : /中文|普通话|mandarin|chinese|华文/.test(text) ? "zh" : /马来|malay|melayu/.test(text) ? "ms"
        : /泰|thai/.test(text) ? "th" : /印尼|indonesia|bahasa/.test(text) ? "id" : "en";
      setTarget(tg);
      setRows((r) => [...r, { who: "sys", text: `🎧 Interpreter on → ${LNAME[tg]}. Speak freely; tap the button to stop.` }]);
      stopPartner(); startInterpreter(tg);
      return;
    }
    const g = parseGoal(text);
    if (g && !objectiveDone.current) {
      objectiveDone.current = true;
      setRows((r) => [...r, { who: "log", log: { summary: "Objective captured from your voice", growth_pct: g.pct, horizon_days: g.days, language: "Minnan/Hokkien via ASR" } }]);
    }
    const eng = partnerRef.current ?? ensurePartner();
    void (async () => {
      const ready = await (eng.waitForReady?.(14000) ?? Promise.resolve(true));
      if (!ready || !eng.sendTextTurn?.(text))
        setRows((r) => [...r, { who: "err", text: ready ? "the voice brain wouldn't take the text turn — try phrasing it as a question" : "couldn't reach the voice session — check 🔐 key" }]);
      else setState("partner");
    })();
  }

  /* ---------- the single button ---------- */
  function press() {
    switch (state) {
      case "idle": case "partner": void beginTurn(); break;
      case "recording": finishTurn(); break;
      case "processing": break;
      case "interpreter":
        try { interpRef.current?.stop(); } catch { /* noop */ }
        interpRef.current = null; setState("idle"); clock(false);
        setRows((r) => [...r, { who: "sys", text: "🎧 Interpreter stopped. Tap to talk to AIVORA again." }]);
        break;
    }
  }
  function release() {
    if (Date.now() - downAt.current > 450 && state !== "processing") hangUp();
  }

  const label =
    state === "recording" ? "● recording · tap to send · hold to hang up"
    : state === "processing" ? "listening to your words… (Min-Nan ASR)"
    : state === "interpreter" ? `🎧 interpreting → ${LNAME[target] ?? target} · tap to stop`
    : state === "partner" ? "● call open · tap to speak again · hold to hang up"
    : "press to talk to AIVORA";

  return (
    <div className="view talkview">
      <div className="conv talkfeed" ref={feedRef}>
        {rows.length === 0 && (
          <div className="talk-hero">
            <img src="/logo.png" alt="AIVORA" />
            <h2>Talk to AIVORA</h2>
            <p>One press. Speak <b>闽南话 Hokkien · 廣東話 · 普通话 · English</b>.<br />
              Your words are heard by a Min-Nan specialist, answered by voice.</p>
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
          onPointerDown={() => { downAt.current = Date.now(); }}
          onPointerUp={release} onClick={press}
          aria-label="Talk to AIVORA">
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
