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

/* ---------------- realtime voice engine ---------------- */
const WORKLET = `class Pcm16k extends AudioWorkletProcessor {
  process(inputs){ const ch=inputs[0]&&inputs[0][0]; if(ch){
    const i16=new Int16Array(ch.length);
    for(let i=0;i<ch.length;i++){const s=Math.max(-1,Math.min(1,ch[i]));i16[i]=s<0?s*0x8000:s*0x7FFF;}
    this.port.postMessage(i16.buffer,[i16.buffer]); } return true; }
}
registerProcessor('pcm16k',Pcm16k);`;

export type LiveEvent =
  | { kind: "ready" }
  | { kind: "user"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "translated"; text: string }
  | { kind: "objective"; data: { summary?: string; growth_pct?: number; horizon_days?: number; language?: string; action_items?: string[] } }
  | { kind: "error"; msg: string }
  | { kind: "closed" };

export function openRealtime(mode: "omni" | "translate", target: string, onEvent: (e: LiveEvent) => void) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/realtime?mode=${mode}&target=${encodeURIComponent(target)}`);
  let dead = false;
  let gotDelta = false;
  const emit = (e: LiveEvent) => { if (!dead) onEvent(e); };

  ws.onopen = () => {
    const c = loadConfig();
    ws.send(c ? JSON.stringify({ type: "__auth", key: c.key, ws: c.ws, region: c.region }) : JSON.stringify({ type: "__hello" }));
  };
  ws.onclose = () => emit({ kind: "closed" });
  ws.onerror = () => emit({ kind: "error", msg: "relay connection failed (offline or demo mode)" });
  ws.onmessage = (m) => {
    let ev: Record<string, any>;
    try { ev = JSON.parse(m.data as string); } catch { return; }
    switch (ev.type) {
      case "session.updated": emit({ kind: "ready" }); break;
      case "conversation.item.input_audio_transcription.completed": emit({ kind: "user", text: ev.transcript }); break;
      case "response.audio_transcript.delta": gotDelta = true; emit({ kind: "translated", text: ev.delta }); break;
      case "response.audio_transcript.done":
        if (mode === "translate") { if (gotDelta) { gotDelta = false; break; } emit({ kind: "translated", text: ev.transcript }); }
        else emit({ kind: "reply", text: ev.transcript });
        break;
      case "response.text.delta": if (mode === "translate") { gotDelta = true; emit({ kind: "translated", text: ev.delta }); } break;
      case "response.function_call_arguments.done":
        if (ev.name === "log_call") { try { emit({ kind: "objective", data: JSON.parse(ev.arguments || "{}") }); } catch { /* bad json */ } }
        break;
      case "response.audio.delta": playPcm(b64bytes(ev.delta)); break;
      case "error": emit({ kind: "error", msg: ev.error?.message ?? "realtime error" }); break;
    }
  };

  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let playAt = 0;
  let muted = false;

  async function ensureCtx() {
    if (ctx) return ctx;
    ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    return ctx;
  }

  const playPcm = (u8: Uint8Array) => {
    if (!ctx) return;
    const buf = ctx.createBuffer(1, Math.floor(u8.length / 2), 24000);
    const ch = buf.getChannelData(0);
    const i16 = new Int16Array(u8.buffer.slice(0, u8.byteLength) as ArrayBuffer);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 0x8000;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    playAt = Math.max(playAt, ctx.currentTime || 0); src.start(playAt); playAt += buf.duration;
  };

  return {
    get socket() { return ws; },
    async startMic() {
      const c = await ensureCtx();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const node = new AudioWorkletNode(c, "pcm16k");
      c.createMediaStreamSource(stream).connect(node);
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (muted) return;
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64(e.data) }));
      };
    },
    setMuted(v: boolean) { muted = v; },
    playPcm,
    stop() {
      dead = true;
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "session.stop" })); } catch { /* noop */ }
      stream?.getTracks().forEach((t) => t.stop());
      try { ws.close(); } catch { /* noop */ }
      void ctx?.close().catch(() => undefined);
      ctx = null; stream = null;
    },
  };
}

const b64 = (b: ArrayBuffer) => {
  const u = new Uint8Array(b); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const b64bytes = (s: string) => { const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

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
