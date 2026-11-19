import { useRef, useState } from "react";
import { analyzeStream, blobsToWav, fileToDataUrl } from "./lib";

/* AIVORA document / photo / voice-note translation via qwen3.8-omni-flash (HTTP proxy). */
const TARGETS = [["en", "English"], ["zh-Hant", "繁體中文"], ["ms", "Bahasa Melayu"], ["th", "ไทย"], ["id", "Bahasa Indonesia"], ["ta", "தமிழ்"]] as const;
type Mode = "text" | "photo" | "voice";

export function DocsView() {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [img, setImg] = useState<{ url: string; name: string } | null>(null);
  const [recSecs, setRecSecs] = useState<number | null>(null);
  const [wav, setWav] = useState<{ url: string; name: string } | null>(null);
  const [target, setTarget] = useState("en");
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const srcLang = target === "en" ? "its original language (may be Chinese, Malay, Tamil or a dialect)" : "its original language";
  const canGo = !running && (mode === "text" ? text.trim().length > 0 : mode === "photo" ? !!img : !!wav);

  async function pickPhoto(f: File | null) {
    if (!f) return;
    setWav(null);
    setImg({ url: await fileToDataUrl(f.slice(0, 3_500_000)), name: f.name || "camera.jpg" });
  }
  async function startVoice() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = await blobsToWav(chunks.current);
        setWav({ url: await fileToDataUrl(blob), name: `voice-note ${new Date().toLocaleTimeString()}` });
      };
      rec.start();
      mediaRef.current = rec;
      let n = 0; setRecSecs(0);
      timerRef.current = window.setInterval(() => {
        setRecSecs(++n);
        if (n >= 45) stopVoice();
      }, 1000);
    } catch { setErr("Microphone unavailable — record a voice note on a device with a granted mic."); }
  }
  function stopVoice() {
    try { mediaRef.current?.state === "recording" && mediaRef.current.stop(); } catch { /* noop */ }
    if (timerRef.current) window.clearInterval(timerRef.current);
    setRecSecs(null);
  }

  async function go() {
    setErr(null); setOut(""); setRunning(true);
    const instr =
      `You are AIVORA's professional translator. Translate the user's ${mode === "photo" ? "photo of a document" : mode === "voice" ? "voice note (speech)" : "text"} into ${TARGETS.find(([v]) => v === target)?.[1] ?? target}. Source may be in ${srcLang}. ` +
      (mode === "voice" ? "First output '### TRANSCRIPTION' with the original speech written down, then '### TRANSLATION' with the translation. " : "") +
      "Preserve layout, numbers, names and units. No commentary.";
    const content: unknown[] = [{ type: "text", text: instr }];
    if (mode === "text") content.push({ type: "text", text: `\n---\n${text}` });
    if (mode === "photo" && img) content.push({ type: "image_url", image_url: { url: img.url } });
    if (mode === "voice" && wav) content.push({ type: "input_audio", input_audio: { data: wav.url, format: "wav" } });
    try {
      let acc = "";
      await analyzeStream([{ role: "user", content }], (d) => { acc += d; setOut(acc); });
      if (!acc) setErr("Empty response from qwen3.8-omni-flash.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setRunning(false); }
  }

  return (
    <div className="docspad">
      <div className="optcard">
        <h4>1 · WHAT ARE WE TRANSLATING?</h4>
        <div className="optrow">
          {(["text", "photo", "voice"] as Mode[]).map((m) => (
            <button key={m} className={`lpill${mode === m ? " sel" : ""}`} onClick={() => setMode(m)}>
              {m === "text" ? "⌨️ Text" : m === "photo" ? "📷 Photo" : "🎙 Voice note"}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 11 }}>
          {mode === "text" && (
            <textarea className="darea" placeholder="Paste a supplier message, contract extract, email…" value={text} onChange={(e) => setText(e.target.value)} />
          )}
          {mode === "photo" && (
            <label className="thumbwrap" style={{ cursor: "pointer" }}>
              <input className="hidden-file" type="file" accept="image/*" capture="environment" onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)} />
              {img ? <img src={img.url} alt="document to translate" />
                : <span className="lpill" style={{ alignItems: "center", gap: 8 }}>＋ Capture / choose a photo</span>}
              <small>{img ? img.name : "A photo of the document — receipts, letters, whiteboards. JPG up to ~3.5 MB."}</small>
            </label>
          )}
          {mode === "voice" && (
            <div className="optrow" style={{ alignItems: "center" }}>
              {recSecs === null
                ? <button className="lpill" onClick={startVoice}>● Record voice note</button>
                : <button className="lpill sel" onClick={stopVoice}>■ Stop · {String(Math.floor(recSecs / 60))}:{String(recSecs % 60).padStart(2, "0")}</button>}
              {wav && <small style={{ color: "var(--wa-teal)", fontWeight: 700 }}>✓ {wav.name} ready</small>}
            </div>
          )}
        </div>
      </div>

      <div className="optcard">
        <h4>2 · TRANSLATE INTO</h4>
        <div className="optrow">
          {TARGETS.map(([v, l]) => (
            <button key={v} className={`lpill${target === v ? " sel" : ""}`} onClick={() => setTarget(v)}>{l}</button>
          ))}
        </div>
      </div>

      <button className="gobtn" disabled={!canGo} onClick={go}>
        {running ? "Translating…" : "✨ Translate with AIVORA"}
      </button>

      {err && <p className="mstat bad" style={{ marginTop: 12 }}>✕ {err}</p>}

      {(out || running) && (
        <div className="transout" style={{ marginTop: 14 }}>
          <span className="chip2">RESULT → {TARGETS.find(([v]) => v === target)?.[1]}</span>
          {mode === "voice" && out.startsWith("###") && (() => {
            const [, tran, rest] = out.split(/###\s*TRANSLATION/);
            return <><div className="from">{tran?.trim()}</div><div className="result stream">{rest?.trimStart()}</div></>;
          })()}
          {!(mode === "voice" && out.startsWith("###")) && <div className={`result${running ? " stream" : ""}`}>{running && !out ? "" : out}</div>}
        </div>
      )}
      <p className="dnote">One request per document — this tab runs the batch model <b>qwen3.8-omni-flash</b> (understands printed text, photos and speech); the call &amp; interpreter tabs use the realtime models.</p>
    </div>
  );
}
