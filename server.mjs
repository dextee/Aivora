/* AIVORA ODAI — dynamic Page server
 * Static client (./dist) + Model Studio integration per INTEGRATION.md:
 *   WS   /realtime?mode=omni|translate   → qwen3.8-omni-flash-realtime / qwen3.8-livetranslate-flash-realtime
 *   POST /api/analyze {messages}         → qwen3.8-omni-flash (HTTPS, text output; media as data-URL/base64 parts)
 *   GET  /api/keyinfo                    → {"source":"env"|"none"}  (one bit; the key itself is never exposed)
 *   GET  /api/health, /                  → scaffold behavior unchanged (health independent of owner env)
 * Key precedence (Phase 2b): Page env DASHSCOPE_API_KEY > browser 🔐 key via first __auth frame
 * (used for that socket only, never logged). Owner config read at REQUEST time — import-time use
 * of owner vars is forbidden (pre-publish validation boots without them).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { storeStart, storeJob, storeDiag } from "./server/hashmeta.mjs";

const host = process.env.HOST;
const port = Number(process.env.PORT);
if (!host) throw new Error("HOST is required");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be 1-65535");

const WORKSPACE = () => process.env.WORKSPACE_ID || "ws-lj7gmtttiltwjlyv";
const REGION = () => process.env.QWEN_REGION || "ap-southeast-1";
const KEY = () => process.env.DASHSCOPE_API_KEY || null;
const MODELS = { omni: "qwen3.8-omni-flash-realtime", translate: "qwen3.8-livetranslate-flash-realtime", analyze: "qwen3.8-omni-flash", audio: "qwen-audio-3.1-realtime-flash" };

/* ---------------- static (scaffold) ---------------- */
const clientRoot = fileURLToPath(new URL("./dist/", import.meta.url));
const clientRootPrefix = clientRoot.endsWith(sep) ? clientRoot : `${clientRoot}${sep}`;
const indexPath = resolve(clientRoot, "index.html");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".gif", "image/gif"], [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".svg", "image/svg+xml"], [".webp", "image/webp"],
  [".woff", "font/woff"], [".woff2", "font/woff2"],
]);
function send(response, status, body, contentType) {
  response.writeHead(status, { "content-type": contentType, "x-content-type-options": "nosniff" });
  response.end(body);
}
async function existingFile(p) {
  try { const d = await stat(p); return d.isFile() ? p : null; }
  catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e; }
}
async function resolveClientFile(pathname) {
  let decoded; try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const rel = decoded.replace(/^\/+/, "") || "index.html";
  const candidate = resolve(clientRoot, rel);
  if (candidate !== clientRoot && !candidate.startsWith(clientRootPrefix)) return null;
  const file = await existingFile(candidate);
  return file ?? (extname(decoded) ? null : await existingFile(indexPath));
}

/* ---------------- realtime session payloads (docs-verified 2026-11) ---------------- */
const AIVORA_INSTRUCTIONS =
  "You are AIVORA, an objective-driven business partner on a live voice call. Detect the user's " +
  "language and dialect automatically and reply in it. Keep answers " +
  "SHORT and conversational (this is voice). When a measurable business objective is stated, call " +
  "log_call with the details AND a one-line summary. Reply in the language the user used.";

function sessionUpdate(mode, q) {
  if (mode === "audio")
    // qwen-audio-3.1-realtime-flash (owner reference client, 2026-11-18):
    // speech-to-speech audio model, voice longanqian, classic server_vad.
    return { type: "session.update", session: {
      modalities: ["text", "audio"],
      voice: "longanqian",
      turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 500 },
    } };
  if (mode === "translate") {
    return { type: "session.update", session: {
      input_modalities: ["audio"], output_modalities: ["text", "audio"],
      audio: { input: { format: { type: "pcm", sample_rate: 16000 },
        turn_detection: { type: "speaker_detection", threshold: 0.5 } },
        output: { voice: "Tina" } },
      translation: { language: (q.get("target") || "en").toLowerCase() },
    } };
  }
  return { type: "session.update", session: {
    modalities: ["text", "audio"], voice: "Tina", input_audio_format: "pcm",
    instructions: AIVORA_INSTRUCTIONS,
    turn_detection: { type: "semantic_vad", threshold: 0.1, silence_duration_ms: 900 },
    tools: [{ type: "function", function: {
      name: "log_call", description: "Summarize/objective captured from this business call.",
      parameters: { type: "object", properties: {
        summary: { type: "string" }, growth_pct: { type: "number" },
        horizon_days: { type: "number" }, language: { type: "string" },
        action_items: { type: "array", items: { type: "string" } } } } } }],
  } };
}

/* ---------------- server + websocket relay ---------------- */
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://qwenwork.local");

    if (url.pathname === "/api/health")
      return send(response, 200, JSON.stringify({ status: "ok" }), "application/json; charset=utf-8");

    if (url.pathname === "/api/keyinfo" && request.method === "GET")
      return send(response, 200, JSON.stringify({ source: KEY() ? "env" : "none" }), "application/json; charset=utf-8");

    if (url.pathname === "/api/analyze" && request.method === "POST")
      return analyze(request, response);

    if (url.pathname === "/api/store/generate" && request.method === "POST")
      return storeRoute(request, response, storeStart, true);

    if (url.pathname === "/api/store/job")
      return sendResponse(response, storeJob(url.searchParams.get("id") || ""));

    if (url.pathname === "/api/store/diag")
      return storeRoute(request, response, storeDiag, false);

    if (url.pathname === "/api/webrtc/sdp" && request.method === "POST")
      return sdpProxy(request, response, url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return send(response, 405, "Method Not Allowed", "text/plain; charset=utf-8");
    }
    const file = await resolveClientFile(url.pathname);
    if (!file) return send(response, 404, "Not Found", "text/plain; charset=utf-8");
    const body = request.method === "HEAD" ? undefined : await readFile(file);
    return send(response, 200, body, contentTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream");
  } catch (error) {
    console.error("Request failed", error);
    send(response, 500, "Internal Server Error", "text/plain; charset=utf-8");
  }
});

/* POST /api/webrtc/sdp?model=… → forward the browser's Offer SDP to Model Studio
   with the server-side key and return the Answer SDP unmodified (plain text).
   Media flows browser ⇄ Model Studio directly afterwards; the key never leaves here. */
async function sdpProxy(request, response, url) {
  const k = KEY();
  let auth = null;
  try { auth = JSON.parse(decodeURIComponent(request.headers["x-aivora-auth"] || "null")); } catch { /* optional */ }
  const useKey = k || auth?.key;
  if (!useKey)
    return send(response, 503, JSON.stringify({ error: "No Model Studio key — set the Page env var or connect one under 🔐." }), "application/json; charset=utf-8");
  const model = url.searchParams.get("model") || MODELS.omni;
  if (!Object.values(MODELS).includes(model)) return send(response, 400, "unknown model", "text/plain; charset=utf-8");
  let offer = "";
  for await (const c of request) { offer += c; if (offer.length > 64_000) return send(response, 413, "offer too large", "text/plain; charset=utf-8"); }
  const wsId = auth?.ws || WORKSPACE(), region = auth?.region || REGION();
  let upstream;
  try {
    upstream = await fetch(`https://${wsId}.${region}.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${useKey}`, "content-type": "application/sdp" },
      body: offer,
    });
  } catch { return send(response, 502, "SDP exchange unreachable", "text/plain; charset=utf-8"); }
  const text = await upstream.text();
  if (!upstream.ok) return send(response, 502, `Model Studio: ${upstream.status} ${text.slice(0, 200)}`, "text/plain; charset=utf-8");
  send(response, 200, text, "application/sdp");
}

/* POST /api/analyze → qwen3.8-omni-flash. Body {messages:[...]} (image_url parts may be
   data: URLs). Streams upstream SSE through untouched. Key never echoed. */
async function analyze(request, response) {
  const k = KEY();
  let auth = null;
  try { auth = JSON.parse(decodeURIComponent(request.headers["x-aivora-auth"] || "null")); } catch { /* optional */ }
  if (!k && !auth?.key)
    return send(response, 503, JSON.stringify({ error: "No Model Studio key — set the Page env var or connect one under 🔐." }), "application/json; charset=utf-8");
  let raw = "";
  for await (const c of request) raw += c;
  const { messages } = JSON.parse(raw || "{}");
  if (!Array.isArray(messages))
    return send(response, 400, JSON.stringify({ error: "messages[] required" }), "application/json; charset=utf-8");
  const wsId = auth?.ws || WORKSPACE(), region = auth?.region || REGION();
  const upstream = await fetch(`https://${wsId}.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${k || auth.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODELS.analyze, messages, modalities: ["text"], stream: true,
      stream_options: { include_usage: true } }),
  });
  if (!upstream.ok) { const t = await upstream.text(); return send(response, upstream.status, t, "text/plain; charset=utf-8"); }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  upstream.body.pipeTo(new WritableStream({ write: (c) => response.write(c), close: () => response.end(), abort: () => response.end() }))
    .catch(() => response.end());
}

function sendResponse(response, out) {
  return send(response, out.status, out.body, out.type);
}

/* glue for the Hashmeta bridge: read body, build env, send module response */
async function storeRoute(request, response, fn, hasBody) {
  let spec = {};
  if (hasBody) {
    let raw = "";
    for await (const c of request) { raw += c; if (raw.length > 200_000) return send(response, 413, "payload too large", "text/plain; charset=utf-8"); }
    try { spec = JSON.parse(raw || "{}"); } catch { return send(response, 400, '{"error":"bad json"}', "application/json; charset=utf-8"); }
  }
  let auth = null;
  try { auth = JSON.parse(decodeURIComponent(request.headers["x-aivora-auth"] || "null")); } catch { /* optional */ }
  const env = {
    hashmetaToken: process.env.HASHMETA_API_TOKEN || null,
    hashmetaUrl: process.env.HASHMETA_MCP_URL || null,
    storeTool: process.env.HASHMETA_STORE_TOOL || null,
    modelStudioKey: KEY() || auth?.key || null,
    workspace: auth?.ws || WORKSPACE(), region: auth?.region || REGION(), analyzeModel: MODELS.analyze,
  };
  try {
    const out = await fn(spec, env);
    return send(response, out.status, out.body, out.type);
  } catch (e) {
    return send(response, 500, JSON.stringify({ error: String(e?.message || e) }), "application/json; charset=utf-8");
  }
}

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/realtime") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (browser) => relay(browser, new URL(req.url, "http://x").searchParams));
});

function relay(browser, q) {
  const mode = q.get("mode") === "translate" ? "translate" : q.get("mode") === "audio" ? "audio" : "omni";
  let model = null, pingTimer = null, settle = null;
  const hangUp = () => { clearInterval(pingTimer); clearTimeout(settle);
    try { model?.close(); } catch {} try { browser.close(); } catch {} };
  const die = (msg) => { browser.readyState === 1 &&
    browser.send(JSON.stringify({ type: "error", error: { message: msg } })); hangUp(); };

  const open = (k, wsId, region) => {
    clearTimeout(settle);
    model = new WebSocket(`wss://${wsId}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${MODELS[mode]}`,
      { headers: { Authorization: `Bearer ${k}` } });
    model.on("open", () => {
      model.send(JSON.stringify(sessionUpdate(mode, q)));
      pingTimer = setInterval(() => { try { model.ping(); } catch {} }, 30000); // livetranslate: 10 RPM — reuse, never reconnect-poll
    });
    model.on("message", (m) => browser.readyState === 1 && browser.send(m.toString()));
    model.on("error", () => die("model link failed — check key / region / workspace"));
    model.on("close", (code) => { clearInterval(pingTimer);
      browser.readyState === 1 && browser.send(JSON.stringify({ type: "relay_socket_closed", code }));
      try { browser.close(); } catch {} });
  };

  const envKey = KEY();
  if (envKey) open(envKey, WORKSPACE(), REGION());
  else settle = setTimeout(() => die("Model Studio key not configured — open 🔐 or set WORKSPACE_ID/DASHSCOPE_API_KEY Page env vars."), 10000);

  browser.on("message", (m) => {
    const s = m.toString();
    let parsed = null; try { parsed = JSON.parse(s); } catch { return model?.readyState === 1 && model.send(s); }
    if (parsed.type === "__auth") {
      if (model) return;                       // env key already won precedence
      if (!parsed.key) return die("__auth without key");
      return open(parsed.key, parsed.ws || WORKSPACE(), parsed.region || REGION());
    }
    if (parsed.type === "__hello") return;
    if (parsed.type === "session.stop")
      return model?.readyState === 1 &&
        model.send(JSON.stringify({ type: mode === "translate" ? "session.finish" : "response.cancel" }));
    if (model?.readyState === 1) model.send(s);
  });
  browser.on("close", hangUp);
}

server.listen(port, host, () => console.log(`aivora server on http://${host}:${port}`));
