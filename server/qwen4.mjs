/* AIVORA — Qwen4-Max text brain client (owner integration sample, 2026-11-20).
 * Mirrors MultiModalConversation.call(model="qwen4-max", messages=[{role, content:[{text|image}]}])
 * over HTTP SSE. Two endpoint shapes are tried in order and the first that returns an OK
 * streaming response is cached for later requests in this process:
 *   1) native  https://{q4ws}.{region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *      header X-DashScope-SSE: enable, body {model, input:{messages}};
 *      frames carry output.choices[0].message.content = [{text:"..."}] (cumulative snapshots
 *      or incremental — the delta engine below handles both).
 *   2) OpenAI-compatible fallback https://{ws}.{region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions
 *      body {model, messages, stream:true}; deltas via choices[0].delta.content.
 * q4ws defaults to the owner's Q4 workspace (Q4_WORKSPACE_ID), model to Q4_MODEL || "qwen4-max".
 * Owner config is read at CALL time (import-time use of owner env is forbidden).
 * The key is never logged, echoed, or returned in any error string.
 */

const Q4_WS_DEFAULT = "ws-1r19x1m4e2fa144f";
const Q4_MODEL_DEFAULT = "qwen4-max";

let healthyRoute = null; // "native" | "openai" — cached after the first OK streaming response

/** Concatenated text found in native-format `data:` SSE frames inside a free-form
 *  fragment; "" when there is none (malformed input included — never throws). */
export async function parseDelta(textFragment) {
  if (typeof textFragment !== "string" || !textFragment) return "";
  let out = "";
  for (const text of frameTexts(textFragment)) out += text;
  return out;
}

/** Yield the text of every native-format data frame in a chunk of SSE text. */
function frameTexts(fragment) {
  const texts = [];
  for (const line of fragment.split("\n")) {
    const t = line.trimStart();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const content = JSON.parse(payload)?.output?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        let s = "";
        for (const part of content) if (part && typeof part.text === "string") s += part.text;
        if (s) texts.push(s);
      }
    } catch { /* not a well-formed frame — ignore */ }
  }
  return texts;
}

function scrub(text, key) {
  return key ? String(text).split(key).join("[key]") : String(text);
}

/* OpenAI-compatible mode wants {"type":"text"} on parts; add it without touching
   the message objects the caller passed (native keeps the DashScope shape). */
function toCompatMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((p) => (p && typeof p.text === "string" && !p.type ? { type: "text", text: p.text } : p))
      : m.content,
  }));
}

/**
 * chatQ4(messages, env, onDelta)
 *  messages: native DashScope shape [{role, content:[{text}] } (string content also tolerated)]
 *  env: {key, ws, region, q4ws?, model?}
 *  onDelta(deltaText): called for every incremental piece of the answer.
 * Returns the full answer text. Throws Error("<route>: <status> <upstream snippet>") when
 * every route fails; the snippet is key-scrubbed.
 */
export async function chatQ4(messages, env, onDelta) {
  const key = env?.key;
  if (!key) throw new Error("no Model Studio key");
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages[] required");
  const region = env.region || "ap-southeast-1";
  const ws = env.ws || "ws-lj7gmtttiltwjlyv";
  const q4ws = env.q4ws || process.env.Q4_WORKSPACE_ID || Q4_WS_DEFAULT;
  const model = env.model || process.env.Q4_MODEL || Q4_MODEL_DEFAULT;

  const routes = [
    {
      name: "native",
      url: `https://${q4ws}.${region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "X-DashScope-SSE": "enable" },
      body: { model, input: { messages } },
      stream: streamNative,
    },
    {
      name: "openai",
      url: `https://${ws}.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: { model, messages: toCompatMessages(messages), stream: true },
      stream: streamOpenAI,
    },
  ];
  if (healthyRoute === "openai") routes.reverse();

  let lastError = "qwen4-max unreachable";
  for (const r of routes) {
    let res;
    try {
      res = await fetch(r.url, { method: "POST", headers: r.headers, body: JSON.stringify(r.body) });
    } catch (e) {
      lastError = `${r.name}: network ${scrub(e?.message || e, key)}`;
      continue;
    }
    if (!res.ok || !res.body) {
      const snip = scrub(await res.text().catch(() => ""), key).slice(0, 300);
      lastError = `${r.name}: ${res.status} ${snip}`.trim();
      continue;
    }
    const full = await r.stream(res, onDelta);
    healthyRoute = r.name;
    return full;
  }
  throw new Error(lastError);
}

async function readSseLines(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) onData(line);
  }
  if (buf) for (const line of buf.split("\n")) onData(line);
}

async function streamNative(res, onDelta) {
  let emitted = "";
  await readSseLines(res, (line) => {
    const t = line.trimStart();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let text;
    try {
      const content = JSON.parse(payload)?.output?.choices?.[0]?.message?.content;
      if (!Array.isArray(content)) return;
      text = "";
      for (const p of content) if (p && typeof p.text === "string") text += p.text;
    } catch { return; /* partial frame */ }
    if (!text) return;
    // cumulative snapshots start with what we already emitted; incremental ones don't
    const piece = text.startsWith(emitted) ? text.slice(emitted.length) : text;
    if (piece) { emitted += piece; onDelta(piece); }
  });
  return emitted;
}

async function streamOpenAI(res, onDelta) {
  let full = "";
  await readSseLines(res, (line) => {
    const t = line.trimStart();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const d = JSON.parse(payload)?.choices?.[0]?.delta?.content;
      if (typeof d === "string" && d) { full += d; onDelta(d); }
    } catch { /* partial frame */ }
  });
  return full;
}
