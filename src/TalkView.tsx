import { useEffect, useRef, useState } from "react";
import { openRealtimeRtc, type RtcHandle } from "./rtc";
import { loadConfig, type LiveEvent } from "./lib";
import { IntentChips, ObjectivePlanCard, objectiveCreateOutcome, parseIntentsResponse, type IntentItem, type ObjView } from "./IntentChips";
import { AdminPanel, parseRegistrySummary, sessionRole, type RegistrySummaryView, type Role } from "./RoleGate";
import { getAccessToken } from "./auth";

/* Talk to AIVORA — one big green button, continuous WebRTC session.
 * The partner engine IS qwen-audio-3.1-realtime-flash (rtc.ts PARTNER_MODEL):
 * it hears the microphone directly, including Min Nan — the batch
 * qwen-audio-3.1-asr-flash pipeline was retired by owner decision 2026-11-19
 * (unreliable for Min Nan).
 * Routing stays model-driven: start_interpreter → livetranslate WebRTC
 * session; open_document_translator → qwen3.8-omni-flash Docs screen;
 * goals arrive as log_call cards. If the engine ever rejects the session
 * tools, rtc.ts degrades once and TalkView keywords keep routing (toollessRef). */

/* feat/composer-attachments — a stored file shown as a chip in the composer and
 * echoed on the sent message. `attach` is the rendered (ready) subset. */
type AttachView = { id: string; name: string; kind: string; size: number; analyzable: boolean };
type AttachItem = AttachView & { key: string; mime: string; status: "uploading" | "ready" | "error"; error?: string };

type Row =
  | { who: "me" | "ai" | "sys" | "err"; text: string; label?: string; attach?: AttachView[] }
  | { who: "biz" }
  | { who: "intents"; items: IntentItem[] }
  | { who: "objective"; label: string; obj: ObjView }
  | { who: "pair"; src: string; out: string }
  | { who: "log"; log: Record<string, unknown> };

/* WO-10 — the ten business intents live in the ENGINE (odai/config/intents_registry.json),
 * served by GET /api/odai/intents and scored by POST /api/odai/intents/match.
 * UI-01 (2026-11-20) shipped a chip EXPANSION on the USER idle screen; the
 * UI-01B amendment (owner directive P3, 2026-11-21) REMOVED that expansion from
 * the default render: the voice-first big mic is the sole primary action, the
 * typing composer is retained (optional, understated), and NO intent chip or
 * registry prose renders for the default USER role. Chips + the GET
 * /api/odai/registry summary render ONLY inside AdminPanel (src/RoleGate.tsx)
 * when the client-side demo role is ADMIN (?role=admin, persisted). A matched
 * objective intent on the typed/heard path still renders the awaiting-owner
 * plan card (that flow is unchanged — the plan card is now reachable purely
 * via typed/spoken utterances, never via a chip wall); an unmeasurable
 * statement still surfaces the engine's own restate hint VERBATIM. dashboard/
 * shield engines and the on-demand Today's Business row work exactly as before. */

const LNAME: Record<string, string> = { en: "English", zh: "中文", yue: "廣東話", ms: "Bahasa Melayu", id: "Bahasa Indonesia", th: "ไทย", ta: "தமிழ்" };

type UState = { objective: string | null; tasks_done?: string; whats_done: string[]; awaiting: string | null; company?: { name: string; synthetic?: boolean } };

export function TalkView({ onOpenDocs, onOpenStore }: { onOpenDocs(): void; onOpenStore(seed: { storeName?: string; products?: string; market?: string; language?: string }): void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"idle" | "connecting" | "partner" | "interpreter">("idle");
  const [target, setTarget] = useState("en");
  const [secs, setSecs] = useState(0);
  const engRef = useRef<RtcHandle | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const outBuf = useRef("");
  const pendingUtterance = useRef<string | null>(null);
  const pullRef = useRef<() => Promise<UState | null>>(async () => null);
  const [odaiU, setOdaiU] = useState<{ objective: string | null; tasks_done?: string; whats_done: string[]; awaiting: string | null; company?: { name: string; synthetic?: boolean } } | null>(null);
  const pairOpen = useRef(false);
  const toollessRef = useRef(false);

  /* V31 — Qwen4-Max text composer (independent of the voice session) */
  const [q4text, setQ4text] = useState("");
  const q4busy = useRef(false);
  const q4hist = useRef<{ role: string; content: string }[]>([]); // rolling context, last 12 exchanges

  /* feat/composer-attachments — files staged in the composer via the "+" button */
  const MAX_UPLOAD = 25 * 1024 * 1024;
  const [files, setFiles] = useState<AttachItem[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* UI-01B — the client-side demo role decides which surfaces exist at all.
   * Intent chips + the registry summary are fetched ONLY when role is ADMIN
   * and rendered ONLY inside AdminPanel (src/RoleGate.tsx); the default USER
   * tree never renders or fetches them (zero intent prose client-side stays
   * true — the data still comes from the engine at runtime). */
  const [role] = useState<Role>(() => sessionRole());
  const [intents, setIntents] = useState<IntentItem[] | null>(null);
  const [chipsErr, setChipsErr] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistrySummaryView | null>(null);

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [rows, state]);
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const c = loadConfig();
        const r = await fetch(`/api/odai/view?mode=user&_t=${Date.now()}`, { headers: c?.key ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {} });
        if (r.ok && !dead) { const j = await r.json(); const s = { objective: j.objective ?? null, ...(j["today's_business"] || {}), whats_done: j.whats_done || [], awaiting: j.awaiting ?? null, company: j.company }; setOdaiU(s); return s; }
      } catch { /* offline demo */ }
      return null;
    };
    pullRef.current = pull;
    void pull();
    const id = setInterval(pull, 6000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  async function showDashboard() {
    const s = await pullRef.current();
    setOdaiU(s);
    if (state === "idle") setRows((r) => [...r, { who: "biz" }]);
  }

  async function api(path: string, init?: RequestInit) {
    const c = loadConfig();
    const tok = getAccessToken();
    return fetch(`${path}${path.includes("?") ? "&" : "?"}_t=${Date.now()}`, {
      ...init,
      headers: { "content-type": "application/json", ...(c?.key ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(init?.headers || {}) },
    });
  }

  /* UI-01B — one runtime fetch (cached in state), used ONLY by the Admin role
   * surface: GET /intents returns the engine's current intent list; the client
   * renders it, never rewrites it. */
  async function ensureIntents(): Promise<IntentItem[] | null> {
    if (intents) return intents;
    try {
      const res = await api("/api/odai/intents");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseIntentsResponse(await res.json());
      if (!items.length) throw new Error("empty registry response");
      setIntents(items); setChipsErr(null);
      return items;
    } catch (e) {
      setChipsErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /* AdminPanel's registry summary data: GET /api/odai/registry (counts +
   * version, defensive parse). The USER role never calls this route. */
  async function ensureRegistry(): Promise<void> {
    try {
      const res = await api("/api/odai/registry");
      if (!res.ok) return;
      const parsed = parseRegistrySummary(await res.json());
      if (parsed) setRegistry(parsed);
    } catch { /* admin demo surface — stays honest by absence */ }
  }

  /* ADMIN only: prefetch both data surfaces the panel renders. */
  useEffect(() => {
    if (role !== "ADMIN") return;
    void ensureIntents();
    void ensureRegistry();
  }, [role]);

  /* asked mid-conversation while ADMIN: the answer bubble carries the same
   * clickable chips (USER never has this intercept — see askQ4) */
  async function askIntentsList() {
    const items = await ensureIntents();
    setRows((r) => [...r, items
      ? { who: "intents", items }
      : { who: "err", text: "Intent list unavailable — the engine did not answer" }]);
  }

  /* chip click (reachable only in the ADMIN surface) = type the utterance
   * into the composer and submit it — same submit routine as everything else */
  function chipPick(it: IntentItem) {
    setQ4text(it.utterance);
    void askQ4(it.utterance);
  }

  /* typed/voice utterances are scored by POST /intents/match (registry data decides
   * the intent; no prose lives here). UI-01: an objective intent now takes the
   * TYPED-OBJECTIVE path on the USER screen — POST /api/odai/objectives (api()
   * stamps a fresh ?_t nonce). The engine's measurable template is tried when
   * the raw utterance is not measurable; if that still fails, the server's own
   * restate hint is shown VERBATIM. Either way the objective stops at its
   * awaiting-owner gates — the client never approves anything (WO-09 stays). */
  async function tryIntentMatch(utterance: string): Promise<boolean> {
    try {
      const res = await api("/api/odai/intents/match", { method: "POST", body: JSON.stringify({ utterance }) });
      if (!res.ok) return false;
      const j = (await res.json()) as { intent?: IntentItem | null };
      const it = j?.intent;
      if (!it) return false;
      if (it.engine === "dashboard") {
        setRows((r) => [...r, { who: "ai", text: `Ready to run: ${it.label} — here is Today's Business.` }]);
        void showDashboard();
      } else if (it.engine === "shield-note") {
        setRows((r) => [...r, { who: "ai", text: `Ready to run: ${it.label} — SHIELD keeps watch over publishing, spending and data (simulated); open the SHIELD tab.` }]);
      } else {
        let out = objectiveCreateOutcome(await (await api("/api/odai/objectives", { method: "POST", body: JSON.stringify({ statement: utterance }) })).json().catch(() => null));
        if (!out.ok && it.objective_template) {
          out = objectiveCreateOutcome(await (await api("/api/odai/objectives", { method: "POST", body: JSON.stringify({ statement: it.objective_template }) })).json().catch(() => null));
        }
        if (out.ok) setRows((r) => [...r, { who: "objective", label: it.label, obj: out.obj }]);
        else setRows((r) => [...r, { who: "sys", text: out.hint }]);
      }
      return true;
    } catch { return false; }
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
          else { setRows((r) => [...r, { who: "me", text: e.text }]); void keywordRoute(e.text); void tryIntentMatch(e.text); }
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

  /* feat/composer-attachments helpers */
  const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const kindIcon = (k: string) => k === "image" ? "🖼️" : k === "video" ? "🎬" : k === "audio" ? "🎵" : k === "pdf" ? "📕" : k === "docx" ? "📄" : "📃";

  function readFileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ""); resolve(s.slice(s.indexOf(",") + 1)); };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  async function uploadOne(file: File, key: string) {
    if (file.size > MAX_UPLOAD) {
      setFiles((prev) => prev.map((f) => f.key === key ? { ...f, status: "error", error: `too large (${fmtSize(file.size)} > ${fmtSize(MAX_UPLOAD)})` } : f));
      return;
    }
    try {
      const data = await readFileBase64(file);
      const res = await api("/api/uploads", { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type, data }) });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; file?: AttachView; error?: string } | null;
      if (!res.ok || !j?.ok || !j.file) {
        setFiles((prev) => prev.map((f) => f.key === key ? { ...f, status: "error", error: j?.error || `upload failed (HTTP ${res.status})` } : f));
        return;
      }
      setFiles((prev) => prev.map((f) => f.key === key ? { ...f, ...j.file!, status: "ready" } : f));
    } catch (e) {
      setFiles((prev) => prev.map((f) => f.key === key ? { ...f, status: "error", error: e instanceof Error ? e.message : String(e) } : f));
    }
  }

  function pickFiles(list: FileList | null) {
    if (!list || !list.length) return;
    const chosen = Array.from(list);
    const staged: AttachItem[] = chosen.map((file) => ({
      key: (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      id: "", name: file.name, mime: file.type, kind: "", size: file.size, analyzable: false, status: "uploading",
    }));
    setFiles((prev) => [...prev, ...staged]);
    staged.forEach((s, i) => void uploadOne(chosen[i], s.key));
  }

  function removeFile(key: string) { setFiles((prev) => prev.filter((f) => f.key !== key)); }

  async function askQ4(forced?: string) {
    const text = String(forced ?? q4text).trim();
    if (!text || q4busy.current) return;
    setQ4text("");
    /* feat/composer-attachments: capture ready uploads now; they are sent as ids
     * with this turn and cleared once the request is dispatched. */
    const ready = files.filter((f) => f.status === "ready" && f.id);
    const attachView: AttachView[] = ready.map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size, analyzable: f.analyzable }));
    /* UI-01B: the chip bubble is the ADMIN role surface's answer only. For
     * the default USER role the same question falls through to the engine
     * match below (registry scoring — e.g. "what can you run for me" scores
     * under MIN_SCORE and is no match) and is answered by Qwen4-Max in prose,
     * never as chips. Objective/dashboard/shield intents matched from typed or
     * heard utterances still take their engine path: the awaiting-owner plan
     * card is now reachable purely via the typed/spoken path; nothing is ever
     * approved client-side (WO-09 owner gate). */
    if (role === "ADMIN" && /what can you run|what can.{0,12}for me/i.test(text)) {
      setRows((r) => [...r, { who: "me", text }]);
      void askIntentsList();
      return;
    }
    setRows((r) => [...r, { who: "me", text, ...(attachView.length ? { attach: attachView } : {}) }]);
    if (await tryIntentMatch(text)) return;
    q4busy.current = true;
    setFiles([]);
    q4hist.current = [...q4hist.current, { role: "user", content: text }].slice(-24);
    setRows((r) => [...r, { who: "ai", text: "", label: "Qwen4-Max" }]);
    let acc = "";
    const patch = (t: string) => setRows((r) => {
      const c = [...r]; const last = c[c.length - 1];
      if (last && last.who === "ai" && last.label === "Qwen4-Max") c[c.length - 1] = { ...last, text: t };
      return c;
    });
    try {
      const cfg = loadConfig();
      const res = await fetch(`/api/q4/chat?_t=${Date.now()}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg?.key ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(cfg)) } : {}) },
        body: JSON.stringify({ messages: q4hist.current, ...(ready.length ? { attachments: ready.map((f) => f.id) } : {}) }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]" || !payload) continue;
          let obj: { delta?: string; error?: string } | null = null;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj?.error) throw new Error(obj.error);
          if (typeof obj?.delta === "string" && obj.delta) { acc += obj.delta; patch(acc); }
        }
      }
      if (acc) q4hist.current = [...q4hist.current, { role: "assistant", content: acc }].slice(-24);
      if (!acc) patch("(no text came back — try again or use the mic)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (acc) patch(`${acc} ⚠ ${msg}`);
      else {
        setRows((r) => {
          const c = [...r]; const last = c[c.length - 1];
          if (last && last.who === "ai" && last.label === "Qwen4-Max") c.pop();
          return [...c, { who: "err" as const, text: `Qwen4-Max: ${msg}` }];
        });
      }
    } finally { q4busy.current = false; }
  }

  return (
    <div className="view talkview">
      <div className="conv talkfeed" ref={feedRef}>
        {rows.length === 0 && (
          <>
            <div className="hello"><h2>Hello, Boss! 👋</h2>
                <p>Just tell me what you want done — say it out loud, in any language.
                  {odaiU?.company ? <span className="brandchip">{odaiU.company.name}{odaiU.company.synthetic ? " · demo brand" : ""}</span> : null}</p></div>
            {/* UI-01B: no chip expansion in the default render. AdminPanel
                returns null for the USER role — chips + registry summary
                exist ONLY on the ADMIN role surface (src/RoleGate.tsx). */}
            <AdminPanel role={role} intents={intents} registry={registry} err={chipsErr} onPick={chipPick} />
          </>
        )}
        {rows.map((r, i) => (
          <div key={i} className={`bubrow${r.who === "me" ? " me" : ""}${r.who === "biz" || r.who === "intents" || r.who === "objective" ? " wide" : ""}`}>
            {r.who === "biz" ? <BizPanel u={odaiU} />
              : r.who === "intents" ? <div className="bub"><span className="tag">AIVORA</span>
                  <div className="btxt">Here is what I can run for you — tap one, or say it out loud:
                    <IntentChips items={r.items} onPick={chipPick} />
                  </div></div>
              : r.who === "objective" ? <ObjectivePlanCard label={r.label} o={r.obj} />
              : r.who === "sys" || r.who === "err"
              ? <div className={`bub ${r.who === "err" ? "err" : "sys"}`}>{r.text}</div>
              : r.who === "log" ? <LogCard log={r.log} />
              : r.who === "pair" ? (
                <div style={{ maxWidth: "88%" }}>
                  {r.src && <div className="bub pair-src"><span className="chip2 src">heard</span><div className="btxt">{r.src}</div></div>}
                  <div className="bub" style={{ marginTop: r.src ? 4 : 0 }}><span className="chip2">→ {LNAME[target] ?? target}</span>
                    <div className="btxt" style={{ fontWeight: 600 }}>{r.out || "…"}</div></div>
                </div>
              )
              : <div className="bub"><span className="tag">{r.label ?? (r.who === "me" ? "You" : "AIVORA")}</span>
                  <div className="btxt">{r.text || "…"}</div>
                  {r.attach && r.attach.length > 0 && <div className="attachrow">{r.attach.map((a) => (
                    <span key={a.id} className="attchip" title={a.analyzable ? "text attached to the model" : "stored, not analyzed by the text model"}>
                      {kindIcon(a.kind)} {a.name} · {fmtSize(a.size)}{a.analyzable ? "" : " · not analyzed"}
                    </span>))}</div>}
                  <time>{fmt(secs)}</time></div>}
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
        <button className={`live-btn${isOn ? " on" : ""}${state === "connecting" ? " wait" : ""}`} onClick={press}
          aria-label="Go live — qwen3.8-omni-flash-realtime voice" title="qwen3.8-omni-flash-realtime · live voice">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" fill="currentColor" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          <span>{state === "connecting" ? "connecting…" : isOn ? "LIVE" : "Go live"}</span>
        </button>
      </div>

      {files.length > 0 && (
        <div className="attach-tray">
          {files.map((f) => (
            <span key={f.key} className={`attchip ${f.status}`} title={f.error || `${f.name} · ${fmtSize(f.size)}`}>
              {f.status === "uploading" ? "⏳" : f.status === "error" ? "⚠️" : kindIcon(f.kind)} {f.name} · {fmtSize(f.size)}
              {f.status === "error" && ` — ${f.error}`}
              <button type="button" className="att-x" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.key)}>×</button>
            </span>
          ))}
        </div>
      )}
      <form className="q4bar" onSubmit={(e) => { e.preventDefault(); void askQ4(); }}>
        <button type="button" className="q4attach" aria-label="Attach a file"
          onClick={() => fileRef.current?.click()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
        </button>
        <input ref={fileRef} type="file" multiple className="hidden-file"
          accept="video/mp4,audio/mpeg,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,.mp4,.mp3,.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.txt,.md"
          onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
        <input value={q4text} onChange={(e) => setQ4text(e.target.value)} placeholder="Ask Qwen4-Max anything..."
          aria-label="Ask Qwen4-Max anything" autoComplete="off" />
        <button type="submit" className="q4send" aria-label="Send to Qwen4-Max">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 12l16-8-6 16-2.5-5.5L4 12z" fill="currentColor" /></svg>
        </button>
      </form>
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

function BizPanel({ u }: { u: UState | null }) {
  return (
    <div style={{ width: "100%" }}>
      <div className="bizcard" style={{ margin: 0 }}>
        <h4>📊 Today's Business <span className="test-badge">TEST</span></h4>
        <div className="bizgrid">
          <div className="biz"><label>🛒 Sales</label><b>S$12,480</b> <i className="up">▲ +24%</i></div>
          <div className="biz"><label>👥 Customers</label><b>86</b> <i className="up">▲ +18%</i></div>
          <div className="biz"><label>✅ Tasks done</label><b>{u?.tasks_done ?? "0/10 beats"}</b></div>
          <div className="biz"><label>🗂 Objective</label><b style={{ fontSize: 12 }}>{u?.objective ? String(u.objective).slice(0, 40) : "—"}</b></div>
        </div>
      </div>
      <ul className="donelist" style={{ margin: "8px 0 0" }}>
        {(u?.whats_done.length ? u.whats_done : ["No finished tasks yet — run a demo in MGMT or talk to AIVORA"])
          .slice(0, 4).map((d, i) => <li key={i}>{d}</li>)}
        {u?.awaiting && <li className="awaiting">⏸ Owner approval pending — open the MGMT tab to decide</li>}
      </ul>
      <p className="fineprint" style={{ marginTop: 6, textAlign: "left" }}>figures are verified demo fixtures (TEST) until live ledger data exists</p>
    </div>
  );
}
