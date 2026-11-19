/* AIVORA ODAI — shared runtime: key config, realtime voice engine, analyze client. */

/* ---------------- config (browser 🔐, localStorage only) ---------------- */
export type AiConfig = { key: string; ws: string; region: string };
const STORE = "aivora.cfg";
export const DEFAULT_WS = "ws-lj7gmtttiltwjlyv";
export const REGIONS = [
  ["ap-southeast-1", "Singapore"],
  ["cn-beijing", "China (Beijing)"],
] as const;
export function loadConfig(): AiConfig | null {
  try { const c = JSON.parse(localStorage.getItem(STORE) || "null");
    return c && c.key ? (c as AiConfig) : null; } catch { return null; }
}
export const saveConfig = (c: AiConfig) => localStorage.setItem(STORE, JSON.stringify(c));
export const clearConfig = () => localStorage.removeItem(STORE);

export type ConnSource = "checking" | "env" | "browser" | "none";
export async function probeKey(): Promise<ConnSource> {
  try {
    const r = await fetch("/api/keyinfo");
    if (!r.ok) throw new Error("http");
    const j = (await r.json()) as { source?: string };
    return j.source === "env" ? "env" : loadConfig() ? "browser" : "none";
  } catch { return loadConfig() ? "browser" : "none"; }
}

/* quick key validity ping (1-token non-stream via server proxy is heavier;
   direct compatible-mode call — may CORS-block on some setups, handled) */
export async function testKey(c: AiConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`https://${c.ws}.${c.region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.8-omni-flash", messages: [{ role: "user", content: "ping" }],
        modalities: ["text"], stream: false, max_tokens: 1 }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `Key rejected (HTTP ${res.status}) — wrong key or region.` };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
    return { ok: true, detail: "Key valid on Model Studio." };
  } catch (e) {
    return { ok: false, detail: (e instanceof Error ? e.message : String(e)) + " — browser blocked the direct call (CORS); the in-app routes still work, so this key may be fine." };
  }
}

/* ---------------- shared realtime event vocabulary (WebRTC engine in rtc.ts) ---------------- */
export type LiveEvent =
  | { kind: "ready" }
  | { kind: "user"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "translated"; text: string }
  | { kind: "objective"; data: { summary?: string; growth_pct?: number; horizon_days?: number; language?: string; action_items?: string[] } }
  | { kind: "interpret"; target: string }
  | { kind: "route_docs" }
  | { kind: "error"; msg: string }
  | { kind: "closed" };

/* POST /api/asr → qwen-audio-3.1-asr-flash (Min-Nan specialist ear).
   Lenient extraction across known DashScope output shapes; falls back to the
   longest plausible text field if none match. */
export async function asrTranscribe(audioDataUrl: string): Promise<string> {
  const c = loadConfig();
  const res = await fetch("/api/asr", {
    method: "POST",
    headers: { "content-type": "application/json", ...(c ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {}) },
    body: JSON.stringify({ audio: audioDataUrl }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(/No Model Studio key/.test(t) ? "add a key under 🔐 to wake the ears" : t.slice(0, 160));
  }
  const j = await res.json();
  const o = (j?.output ?? j ?? {}) as Record<string, any>;
  const picks: unknown[] = [
    o.text,
    o.choices?.[0]?.message?.content,
    o.sentence?.text,
    Array.isArray(o.sentences) ? o.sentences.map((s: any) => s?.text ?? s?.sentence ?? "").join("") : null,
    o.result,
  ];
  for (const p of picks) {
    if (typeof p === "string" && p.trim()) return p.trim();
    if (Array.isArray(p)) {
      const txt = p.map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("").trim();
      if (txt) return txt;
    }
  }
  // deep hunt: longest string value in the payload that isn't a URL/id
  let best = "";
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (v.length > best.length && !/^https?:|^data:|^[a-f0-9-]{20,}$/i.test(v)) best = v; return; }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(j);
  if (best.trim()) return best.trim();
  throw new Error("ASR returned no recognizable transcript");
}

/* webm/opus chunks → 16 kHz mono WAV blob (accepted by asr + omni-flash) */
export async function blobsToWav(parts: Blob[]): Promise<Blob> {
  const audio = new Blob(parts, { type: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4" });
  const arr = await audio.arrayBuffer();
  const probe = new OfflineAudioContext(1, 44100, 44100);
  const buf = await probe.decodeAudioData(arr);
  const sr = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * sr), sr);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const w16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) w16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32767));
  const header = new ArrayBuffer(44); const v = new DataView(header);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + w16.byteLength, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, w16.byteLength, true);
  return new Blob([header, w16.buffer], { type: "audio/wav" });
}

/* ---------------- analyze (document translation) ---------------- */
export function fileToDataUrl(f: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(f); });
}

export async function analyzeStream(
  messages: unknown[],
  onDelta: (t: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const c = loadConfig();
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", ...(c ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {}) },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) throw new Error((await res.text()).slice(0, 160) || `HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let full = "", buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const d: string = j.choices?.[0]?.delta?.content ?? "";
        if (d) { full += d; onDelta(d); }
      } catch { /* partial */ }
    }
  }
  return full;
}
