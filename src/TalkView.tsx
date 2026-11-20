import { useEffect, useRef, useState } from "react";
import { openRealtimeRtc, type RtcHandle } from "./rtc";
import { loadConfig, type LiveEvent } from "./lib";

/* Talk to AIVORA — one big green button, continuous WebRTC session.
 * The partner engine IS qwen-audio-3.1-realtime-flash (rtc.ts PARTNER_MODEL):
 * it hears the microphone directly, including Min Nan — the batch
 * qwen-audio-3.1-asr-flash pipeline was retired by owner decision 2026-11-19
 * (unreliable for Min Nan).
 * Routing stays model-driven: start_interpreter → livetranslate WebRTC
 * session; open_document_translator → qwen3.8-omni-flash Docs screen;
 * goals arrive as log_call cards. If the engine ever rejects the session
 * tools, rtc.ts degrades once and TalkView keywords keep routing (toollessRef). */

type Row =
  | { who: "me" | "ai" | "sys" | "err"; text: string }
  | { who: "pair"; src: string; out: string }
  | { who: "log"; log: Record<string, unknown> };

const LNAME: Record<string, string> = { en: "English", zh: "中文", yue: "廣東話", ms: "Bahasa Melayu", id: "Bahasa Indonesia", th: "ไทย", ta: "தமிழ்" };

const EXAMPLES = ["Find new customers", "Increase sales", "Prepare a report", "Follow up customers", "Create product materials", "Check today's results"];

export function TalkView({ onOpenDocs, onOpenStore }: { onOpenDocs(): void; onOpenStore(seed: { storeName?: string; products?: string; market?: string; language?: string }): void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"idle" | "connecting" | "partner" | "interpreter">("idle");
  const [target, setTarget] = useState("en");
  const [secs, setSecs] = useState(0);
  const engRef = useRef<RtcHandle | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const outBuf = useRef("");
  const pendingUtterance = useRef<string | null>(null);
  const [odaiU, setOdaiU] = useState<{ objective: string | null; tasks_done?: string; whats_done: string[]; awaiting: string | null; company?: { name: string; synthetic?: boolean } } | null>(null);
  const pairOpen = useRef(false);
  const toollessRef = useRef(false);

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [rows, state]);
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const c = loadConfig();
        const r = await fetch(`/api/odai/view?mode=user&_t=${Date.now()}`, { headers: c?.key ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {} });
        if (r.ok && !dead) { const j = await r.json(); setOdaiU({ objective: j.objective, ...(j["today's_business"] || {}), whats_done: j.whats_done || [], awaiting: j.awaiting, company: j.company }); }
      } catch { /* offline demo */ }
    };
    void pull();
    const id = setInterval(pull, 6000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  function sayExample(text: string) {
    if (state === "connecting" || state === "interpreter") return;
    setRows((r) => [...r, { who: "me", text }]);
    const eng = engRef.current;
    if (eng?.sendTextTurn?.(text)) return;
    pendingUtterance.current = text;
    void connect("omni");
  }
  useEffect(() => () => { try { engRef.current?.stop(); } catch { /* unmount */ } }, []);
  useEffect(() => {
    if (state !== "partner" && state !== "interpreter") return;
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const isOn = state === "partner" || state === "interpreter";
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  /* keyword router — only active if the audio engine rejected the routing tools */
  function keywordRoute(text: string) {
    if (!toollessRef.current) return false;
    const tg = /廣東話|粤|cantonese/i.test(text) ? "yue" : /英文|english/i.test(text) ? "en"
      : /中文|普通话|mandarin|chinese/i.test(text) ? "zh" : /马来|melayu|malay|malaysia| malaysia/i.test(text) ? "ms"
      : /tamil|தமிழ்|泰米尔/i.test(text) ? "ta" : "en";
    if (/interpret|interpreter|翻译|翻譯|speaks? .{0,12}(language|english|chinese)|另一.?种语言/i.test(text)) {
      setTarget(tg);
      setRows((r) => [...r, { who: "sys", text: `🎧 Interpreter engaged → ${LNAME[tg] ?? tg}. Speak; AIVORA voices the translation. Press the button to stop.` }]);
      try { engRef.current?.stop(); } catch { /* swap */ }
      window.setTimeout(() => connect("translate"), 350);
      return true;
    }
    if (/online store|store ?(page|front)|shop ?front|product catalog(?:ue)?|catalog(?:ue)? page|ecommerce|e-commerce|landing ?page|网店|開店|商店?页面?|頁面|产品目录|產品目錄|上架|做个网页?|做個網頁/i.test(text)) {
      setRows((r) => [...r, { who: "sys", text: "🛒 Building your store page — opening the Store Builder…" }]);
      try { engRef.current?.stop(); } catch { /* handoff */ }
      setState("idle");
      window.setTimeout(() => onOpenStore({ products: text }), 500);
      return true;
    }
    if (/document|contract|photo|paper|invoice|文件|合约|合約|合同|照片|单据/i.test(text)) {
      setRows((r) => [...r, { who: "sys", text: "📄 Opening Document Translation…" }]);
      try { engRef.current?.stop(); } catch { /* handoff */ }
      setState("idle");
      window.setTimeout(onOpenDocs, 500);
      return true;
    }
    return false;
  }

  function connect(mode: "omni" | "translate") {
    setState("connecting"); setSecs(0);
    const eng = openRealtimeRtc(mode, target, (e: LiveEvent) => {
      switch (e.kind) {
        case "ready": {
          setState(mode === "translate" ? "interpreter" : "partner");
          const p = pendingUtterance.current;
          if (p && mode !== "translate") {
            pendingUtterance.current = null;
            if (!engRef.current?.sendTextTurn?.(p))
              setRows((r) => [...r, { who: "err", text: "session opened but the example could not be delivered — try the mic" }]);
          }
          break;
        }
        case "user":
          if (mode === "translate") { outBuf.current = ""; pairOpen.current = true; setRows((r) => [...r, { who: "pair", src: e.text, out: "" }]); }
          else { setRows((r) => [...r, { who: "me", text: e.text }]); void keywordRoute(e.text); }
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
        case "store":
          setRows((r) => [...r, { who: "sys", text: "🛒 Building your store page — opening the Store Builder…" }]);
          try { engRef.current?.stop(); } catch { /* handoff */ }
          setState("idle");
          window.setTimeout(() => onOpenStore({
            storeName: e.data.store_name, products: e.data.products, market: e.data.market, language: e.data.language }), 500);
          break;
        case "error":
          if (e.msg.includes("routing tools rejected")) {
            toollessRef.current = true;
            setRows((r) => [...r, { who: "sys", text: "ℹ️ Voice engine active; say “interpret …” or “translate this document” and AIVORA routes by keywords." }]);
            break;
          }
          setRows((r) => [...r, { who: "err" as const, text: e.msg }]); setState("idle"); break;
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
          <>
            <div className="hello"><h2>Hello, Boss! 👋</h2>
                <p>Just tell me what you want done — say it out loud, in any language.
                  {odaiU?.company ? <span className="brandchip">{odaiU.company.name}{odaiU.company.synthetic ? " · demo brand" : ""}</span> : null}</p></div>
            <div className="exrow" aria-label="Example requests">
              {EXAMPLES.map((x) => <button key={x} className="exchip" onClick={() => sayExample(x)}>“{x}”</button>)}
            </div>
            <div className="bizcard">
              <h4>📊 Today's Business <span className="test-badge">TEST</span></h4>
              <div className="bizgrid">
                <div className="biz"><label>🛒 Sales</label><b>S$12,480</b> <i>▲ +24%</i></div>
                <div className="biz"><label>👥 Customers</label><b>86</b> <i>▲ +18%</i></div>
                <div className="biz"><label>✅ Tasks done</label><b>{odaiU?.tasks_done ?? "0/10 beats"}</b></div>
                <div className="biz"><label>🗂 Objective</label><b style={{ fontSize: 12, color: "#b9f5cf" }}>{odaiU?.objective ? String(odaiU.objective).slice(0, 40) : "—"}</b></div>
              </div>
            </div>
            <ul className="donelist">
              {(odaiU?.whats_done.length ? odaiU.whats_done : ["Run a request above or press Speak Now — completed tasks appear here"]).slice(0, 4).map((d, i) => <li key={i}>{d}</li>)}
              {odaiU?.awaiting && <li style={{ color: "#fbbf24" }}>⏸ Owner approval pending — open MGMT tab to decide</li>}
            </ul>
            <p className="fineprint" style={{ marginTop: 8 }}>sales/customer figures are demo fixtures (TEST) until live ledger data exists</p>
          </>
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
