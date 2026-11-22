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
import { storeRun, storeDiag, BUILD } from "./server/hashmeta.mjs";
import { chatQ4 } from "./server/qwen4.mjs";
import { startRun, decideSpend, userView, managementView, securityView } from "./server/odai/workflow.mjs";
import { modeAccess, POLICY_VERSION, UNAVAILABLE_RULE_SETS } from "./server/odai/policy.mjs";
import { get, DEMO_TENANT } from "./server/odai/store.mjs";
import { createObjective, approve, resume, finalReport, project, listObjectives, view as objView, salesReport, setDemoSales, requestBoost, applyConstraint } from "./server/odai/objectives.mjs";
import { publicIntents, matchIntent } from "./server/odai/intents.mjs";
import { registrySummary } from "./server/odai/registry.mjs"; // WO-A1 registry read surface (data plane)
import { runWithToken, supabaseConfigured, isOffline, putUpload, approveUpload, requestCtx } from "./server/odai/db.mjs"; // feat: request-scoped Supabase bearer + Storage (RLS-enforced)
// ECOMMERCE (V43) coffee-storyboard modules — integrated additively into MAIN's existing dispatcher (no second dispatcher).
import { storeSetup, storeIntent, hasSession as hasStoreSession, storeRecord, storeExport, resetStore } from "./server/odai/store_setup.mjs";
import { submitCoffeePlan, getPlan as getPlanById } from "./server/odai/plan_engine.mjs";
import { listLeads, addLead, draftFollowup } from "./server/odai/leads.mjs";
import { createCampaign as mktCreate, attachAsset as mktAttach, getCampaign as mktGet, latestCampaign as mktLatest } from "./server/odai/marketing.mjs";
import { createCampaign as hmCreate, uploadCreative as hmUpload, preparePublication as hmPrepare, approvePublication as hmApprove, submit as hmSubmit, getCampaignStatus as hmStatus, getCampaignMetrics as hmMetrics, getRecord as hmRecord } from "./server/odai/hashmeta_adapter.mjs";
import { seedMock as custSeed, createCustomer, updateCustomer, getCustomer, searchCustomers, importCustomers, addPurchase, getPurchaseHistory, identifyRepeatBuyers, identifyInactiveBuyers, analyzePurchasePatterns, recommendProducts, prepareFollowup, scheduleFollowup, listFollowups, savePurchaseHealed, registerAgent, exportCustomers, generateReport, getThresholds, setThresholds } from "./server/odai/customers.mjs";
import { runShop, getShop, attemptPriceChange, dropshipList, addProducts, removeProduct } from "./server/odai/shop_setup.mjs";
import { storeUpload, getUploadMeta, publicMeta, contextForAttachments, MAX_BYTES } from "./server/uploads.mjs"; // feat/composer-attachments: local upload sink

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
const server = createServer((request, response) => {
  // feat: carry the caller's Supabase access token (if any) for request-scoped RLS.
  const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "") || null;
  return runWithToken(bearer, async () => {
  try {
    const url = new URL(request.url ?? "/", "http://qwenwork.local");

    if (url.pathname === "/api/health")
      return send(response, 200, JSON.stringify({ status: "ok" }), "application/json; charset=utf-8");

    if (url.pathname === "/api/build")
      return send(response, 200, JSON.stringify({ build: BUILD }), "application/json; charset=utf-8");

    if (url.pathname === "/api/keyinfo" && request.method === "GET")
      return send(response, 200, JSON.stringify({ source: KEY() ? "env" : "none" }), "application/json; charset=utf-8");

    // feat: client-safe Supabase auth bootstrap. Publishable key + URL are designed for
    // clients; the service-role key is NEVER exposed here. When Supabase isn't configured
    // the app keeps its existing offline/owner-key behavior.
    if (url.pathname === "/api/config/supabase" && request.method === "GET")
      return send(response, 200, JSON.stringify(supabaseConfigured()
        ? { configured: true, url: process.env.SUPABASE_URL, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY, instanceId: process.env.SUPABASE_INSTANCE_ID }
        : { configured: false }), "application/json; charset=utf-8");

    if (url.pathname === "/api/analyze" && request.method === "POST")
      return analyze(request, response);

    if (url.pathname === "/api/store/generate" && request.method === "POST")
      return storeStream(request, response);

    if (url.pathname === "/api/q4/chat" && request.method === "POST")
      return q4Chat(request, response);

    if (url.pathname === "/api/uploads" && request.method === "POST")
      return uploadReceive(request, response);

    if (url.pathname.startsWith("/api/uploads/") && request.method === "GET")
      return uploadMeta(request, response, url);

    if (url.pathname.startsWith("/api/odai/")) return odaiRoute(url, request, response);

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

/* POST /api/q4/chat — Qwen4-Max text composer (V31).
 * Body {messages:[{role,content(string)}]} hard-capped 64 KB; last 30 used.
 * Responds text/event-stream with data:{"delta":"..."} lines, ends data:[DONE].
 * 4 s comment heartbeats keep the Pages gateway buffering-free. Key never logged. */
async function q4Chat(request, response) {
  const k = KEY();
  let auth = null;
  try { auth = JSON.parse(decodeURIComponent(request.headers["x-aivora-auth"] || "null")); } catch { /* optional */ }
  const useKey = k || auth?.key;
  if (!useKey)
    return send(response, 503, JSON.stringify({ error: "No Model Studio key — add DASHSCOPE_API_KEY to the Page env or connect a key under 🔐." }), "application/json; charset=utf-8");

  let raw = "";
  for await (const c of request) {
    raw += c;
    if (raw.length > 65_536) return send(response, 413, JSON.stringify({ error: "payload too large" }), "application/json; charset=utf-8");
  }
  let parsed;
  try { parsed = JSON.parse(raw || "{}"); } catch { return send(response, 400, JSON.stringify({ error: "bad json" }), "application/json; charset=utf-8"); }
  const msgIn = parsed.messages;
  if (!Array.isArray(msgIn)) return send(response, 400, JSON.stringify({ error: "messages[] required" }), "application/json; charset=utf-8");

  const cleaned = msgIn
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
    .slice(-30);
  if (!cleaned.some((m) => m.role === "user"))
    return send(response, 400, JSON.stringify({ error: "at least one user message required" }), "application/json; charset=utf-8");

  /* feat/composer-attachments: fold any stored attachment context into the last
   * user turn. Text-extractable files contribute real content; others contribute
   * an honest "stored, not analyzed" note. Context is built server-side from
   * ids, so it does not count against the request payload cap above. */
  const attachCtx = contextForAttachments(parsed.attachments);
  if (attachCtx) {
    for (let i = cleaned.length - 1; i >= 0; i--) {
      if (cleaned[i].role === "user") { cleaned[i] = { ...cleaned[i], content: cleaned[i].content + "\n\n" + attachCtx }; break; }
    }
  }

  const sys = { role: "system", content: [{ text: "You are AIVORA's Qwen4-Max text brain. Be concise and helpful. Reply in the users language." }] };
  const nativeMsgs = [sys, ...cleaned.map((m) => ({ role: m.role, content: [{ text: m.content }] }))];

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  const hb = setInterval(() => { try { response.write(": hb\n\n"); } catch { /* closed */ } }, 4000);
  try {
    await chatQ4(nativeMsgs, {
      key: useKey,
      ws: auth?.ws || WORKSPACE(),
      region: auth?.region || REGION(),
    }, (text) => {
      if (!text) return;
      try { response.write(`data: ${JSON.stringify({ delta: text })}\n\n`); } catch { /* closed */ }
    });
  } catch (e) {
    const msg = String(e?.message || e).split(useKey).join("[key]").slice(0, 300);
    try { response.write(`data: ${JSON.stringify({ error: msg })}\n\n`); } catch { /* closed */ }
  } finally {
    clearInterval(hb);
    try { response.write("data: [DONE]\n\n"); response.end(); } catch { /* closed */ }
  }
}

/* POST /api/uploads — receive one base64 file (feat/composer-attachments).
 * Body {name, mime, data:base64}. Validates type + size, stores locally, returns
 * metadata. No model key required (storing is local). base64 inflates ~4/3, so the
 * body cap allows a MAX_BYTES file plus JSON wrapper. */
async function uploadReceive(request, response) {
  const maxBody = Math.ceil(MAX_BYTES * 1.4) + 65_536;
  let raw = "";
  for await (const c of request) {
    raw += c;
    if (raw.length > maxBody) return send(response, 413, JSON.stringify({ error: "payload too large" }), "application/json; charset=utf-8");
  }
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { return send(response, 400, JSON.stringify({ error: "bad json" }), "application/json; charset=utf-8"); }
  const r = storeUpload({ name: body.name, mime: body.mime, data: body.data });
  if (!r.ok) return send(response, r.status, JSON.stringify({ error: r.error }), "application/json; charset=utf-8");
  // Supabase mode: mirror the actual file bytes to the private Storage bucket as the
  // signed-in user (RLS-scoped); metadata lives in odai_upload. Offline/no-env stays local-only.
  let storage = null;
  if (supabaseConfigured() && !isOffline()) {
    const tenant = new URL(request.url ?? "/", "http://qwenwork.local").searchParams.get("tenant") || DEMO_TENANT;
    storage = await putUpload({ tenantId: tenant, uploadId: r.meta.id, filename: r.meta.name, body: Buffer.from(body.data, "base64"), contentType: body.mime || "application/octet-stream" });
  }
  return send(response, 200, JSON.stringify({ ok: true, file: r.meta, storage }), "application/json; charset=utf-8");
}

/* GET /api/uploads/:id — metadata for a stored attachment (never bytes or full text). */
function uploadMeta(request, response, url) {
  const id = decodeURIComponent(url.pathname.slice("/api/uploads/".length));
  const meta = getUploadMeta(id);
  if (!meta) return send(response, 404, JSON.stringify({ error: "not found" }), "application/json; charset=utf-8");
  return send(response, 200, JSON.stringify({ file: publicMeta(meta) }), "application/json; charset=utf-8");
}

async function storeStream(request, response) {
  let raw = "";
  for await (const c of request) raw += c;
  let auth = null;
  try { auth = JSON.parse(decodeURIComponent(request.headers["x-aivora-auth"] || "null")); } catch { /* optional */ }
  let spec = null;
  try { spec = JSON.parse(raw || "{}"); } catch { spec = null; }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  const hb = setInterval(() => { try { response.write(": hb\n\n"); } catch { /* closed */ } }, 4000);
  const env = {
    hashmetaToken: process.env.HASHMETA_API_TOKEN || null,
    hashmetaUrl: process.env.HASHMETA_MCP_URL || null,
    storeTool: process.env.HASHMETA_STORE_TOOL || null,
    modelStudioKey: KEY() || auth?.key || null,
    workspace: auth?.ws || WORKSPACE(), region: auth?.region || REGION(), analyzeModel: MODELS.analyze,
  };
  let out;
  try { out = await storeRun(spec || {}, env); }
  catch (e) { out = { error: String(e?.message || e) }; }
  clearInterval(hb);
  response.write(`data: ${JSON.stringify(out)}\n\n`);
  response.end();
}

/* ---------------- ODAI 9.0 routes: modes, governed demo, projections ---------------- */
async function odaiRoute(url, request, response) {
  const tenant = url.searchParams.get("tenant") || DEMO_TENANT;
  const json = (obj, status = 200) => send(response, status, JSON.stringify(obj), "application/json; charset=utf-8");
  const path = url.pathname.replace("/api/odai", "");
  // Supabase mode: every ODAI request must be scoped to a signed-in user (bearer).
  // Offline / no-env keeps the existing unauthenticated demo behavior.
  if (supabaseConfigured() && !isOffline() && !requestCtx.getStore()?.token)
    return json({ error: "A signed-in user is required in Supabase mode", code: "AUTH_REQUIRED" }, 401);
  try {
    /* ---- ECOMMERCE (V43) coffee-storyboard integration — additive routes on MAIN's dispatcher ---- */
    if (path === "/submit" && request.method === "POST") {
      let raw = ""; for await (const c of request) raw += c;
      const { text, request_id, source, objective_id } = JSON.parse(raw || "{}");
      const statement = String(text || "").slice(0, 300);
      if (!statement.trim()) return json({ error: "empty submission" }, 400);
      if (objective_id == null && (hasStoreSession(tenant) || storeIntent(statement))) return json(await storeSetup(tenant, { text: statement, request_id, source }));
      if (objective_id == null && /launch .*coffee business|start .*coffee business|coffee business/i.test(statement)) return json(await submitCoffeePlan(tenant, statement, request_id));
      if (objective_id == null && /set up my online (coffee )?shop|help me (set up|open) .*shop|open (an?|my|another) (online )?shop|online coffee shop|set up my shop|my online shop/i.test(statement)) return json(await runShop(tenant, { name: "AIVORA Coffee", language: "English", objective_id: request_id }));
      if (objective_id == null && /best customers|most valuable|lifetime value|not purchased recently|inactive|likely to purchase|repeat buyer|popular product|purchase together|which products|monthly customer report|recommend .*campaign/i.test(statement)) {
        if (/best customers|most valuable|lifetime value/i.test(statement)) return json({ objective: "OBJ-CUSTOMER-001/007", report: generateReport(tenant), top_customers: identifyRepeatBuyers(tenant).sort((a, b) => b.total_purchase_amount - a.total_purchase_amount).slice(0, 5) });
        if (/not purchased recently|inactive/i.test(statement)) return json({ objective: "OBJ-CUSTOMER-002", inactive_customers: identifyInactiveBuyers(tenant) });
        if (/likely to purchase|repeat buyer|promotion for repeat/i.test(statement)) return json({ objective: "OBJ-CUSTOMER-003/005", repeat_buyers: identifyRepeatBuyers(tenant) });
        if (/popular product|purchase together|which products/i.test(statement)) return json({ objective: "OBJ-CUSTOMER-008/009", patterns: analyzePurchasePatterns(tenant) });
        return json({ objective: "OBJ-CUSTOMER-008", report: generateReport(tenant) });
      }
      return json(await createObjective(tenant, statement)); // MAIN's own objective engine for other goals
    }
    if (path === "/plan" && request.method === "POST") { let raw = ""; for await (const c of request) raw += c; const { statement, request_id } = JSON.parse(raw || "{}"); return json(await submitCoffeePlan(tenant, String(statement || "Launch my RM4 coffee business"), request_id)); }
    if (path.startsWith("/plan/") && request.method === "GET") return json(getPlanById(tenant, decodeURIComponent(path.split("/")[2])));
    if (path === "/store" && request.method === "GET") return json(storeRecord(tenant));
    if (path === "/store/export" && request.method === "GET") return json(storeExport(tenant));
    if (path === "/store" && request.method === "POST") { let raw = ""; for await (const c of request) raw += c; const { action } = JSON.parse(raw || "{}"); if (action === "reset") return json(resetStore(tenant)); if (action === "sync" || action === "regenerate") return json(await storeSetup(tenant, { text: "sync", request_id: "sync:" + Date.now() })); return json({ error: "unknown store action" }, 400); }
    if (path === "/leads" && request.method === "GET") return json(listLeads(tenant));
    if (path === "/leads" && request.method === "POST") { let raw = ""; for await (const c of request) raw += c; return json(addLead(tenant, JSON.parse(raw || "{}"))); }
    if (path.startsWith("/leads/") && path.endsWith("/followup") && request.method === "POST") return json(draftFollowup(tenant, decodeURIComponent(path.split("/")[2])));
    if (path === "/campaign" && request.method === "POST") return json(mktCreate(tenant, {}));
    if (path === "/campaign" && request.method === "GET") return json(mktLatest(tenant));
    if (path.startsWith("/campaign/") && path.endsWith("/assets") && request.method === "POST") { const id = decodeURIComponent(path.split("/")[2]); let raw = ""; for await (const c of request) raw += c; return json(mktAttach(tenant, id, JSON.parse(raw || "{}"))); }
    if (path.startsWith("/campaign/") && request.method === "GET") return json(mktGet(tenant, decodeURIComponent(path.split("/")[2])));
    if (path.startsWith("/hashmeta/")) { const hmEnv = { hashmetaToken: process.env.HASHMETA_API_TOKEN || null, hashmetaUrl: process.env.HASHMETA_MCP_URL || null }; const seg = path.split("/")[2];
      if (seg === "campaign" && request.method === "POST") return json(hmCreate(tenant, hmEnv));
      if (seg === "campaign" && request.method === "GET") return json(hmRecord(tenant));
      if (seg === "creative" && request.method === "POST") return json(hmUpload(tenant, hmEnv));
      if (seg === "prepare" && request.method === "POST") return json(hmPrepare(tenant, hmEnv));
      if (seg === "approve" && request.method === "POST") return json(hmApprove(tenant));
      if (seg === "submit" && request.method === "POST") return json(hmSubmit(tenant, hmEnv));
      if (seg === "status" && request.method === "GET") return json(hmStatus(tenant));
      if (seg === "metrics" && request.method === "GET") return json(hmMetrics(tenant));
      return json({ error: "unknown hashmeta route" }, 404); }
    if (path.startsWith("/customers")) { const body = async () => { let raw = ""; for await (const c of request) raw += c; try { return JSON.parse(raw || "{}"); } catch { return {}; } };
      if (path === "/customers" && request.method === "GET") return json(searchCustomers(tenant, { q: url.searchParams.get("q") || "", category: url.searchParams.get("category") || "", page: +(url.searchParams.get("page") || 1), pageSize: +(url.searchParams.get("pageSize") || 20) }));
      if (path === "/customers" && request.method === "POST") return json(createCustomer(tenant, await body()));
      if (path === "/customers/seed" && request.method === "POST") return json(custSeed(tenant));
      if (path === "/customers/import" && request.method === "POST") { const b = await body(); return json(importCustomers(tenant, Array.isArray(b) ? b : b.rows || [])); }
      if (path === "/customers/report" && request.method === "GET") return json(generateReport(tenant));
      if (path === "/customers/patterns" && request.method === "GET") return json(analyzePurchasePatterns(tenant));
      if (path === "/customers/repeat" && request.method === "GET") return json({ repeat: identifyRepeatBuyers(tenant) });
      if (path === "/customers/inactive" && request.method === "GET") return json({ inactive: identifyInactiveBuyers(tenant) });
      if (path === "/customers/followups" && request.method === "GET") return json(listFollowups(tenant));
      if (path === "/customers/heal-demo" && request.method === "POST") { const b = await body(); return json(savePurchaseHealed(tenant, b.purchase || b, { injectFailure: b.injectFailure !== false })); }
      if (path === "/customers/export" && request.method === "POST") { const b = await body(); return json(exportCustomers(tenant, String(b.agent_id || ""))); }
      if (path.startsWith("/customers/") && request.method === "GET" && path.endsWith("/history")) return json(getPurchaseHistory(tenant, decodeURIComponent(path.split("/")[2])));
      if (path.startsWith("/customers/") && request.method === "GET" && path.endsWith("/recommend")) return json(recommendProducts(tenant, decodeURIComponent(path.split("/")[2])));
      if (path.startsWith("/customers/") && request.method === "POST" && path.endsWith("/purchase")) { const id = decodeURIComponent(path.split("/")[2]); const b = await body(); return json(addPurchase(tenant, { ...b, customer_id: id })); }
      if (path.startsWith("/customers/") && request.method === "POST" && path.endsWith("/followup")) { const id = decodeURIComponent(path.split("/")[2]); const b = await body(); return json(prepareFollowup(tenant, id, (b && b.type) || "thank_you")); }
      if (path.startsWith("/customers/") && request.method === "PATCH") { const id = decodeURIComponent(path.split("/")[2]); return json(updateCustomer(tenant, id, await body())); }
      if (path.startsWith("/customers/") && request.method === "GET") return json(getCustomer(tenant, decodeURIComponent(path.split("/")[2])));
      return json({ error: "unknown customers route" }, 404); }
    if (path.startsWith("/shop")) {
      const rd = async () => { let raw = ""; for await (const c of request) raw += c; try { return JSON.parse(raw || "{}"); } catch { return {}; } };
      if (path === "/shop" && request.method === "POST") return json(await runShop(tenant, await rd()));
      if (path === "/shop" && request.method === "GET") return json(getShop(tenant));
      if (path === "/shop/products" && request.method === "GET") return json({ products: dropshipList() });
      if (path === "/shop/add" && request.method === "POST") { const b = await rd(); return json(addProducts(tenant, b.product_ids || [])); }
      if (path === "/shop/remove" && request.method === "POST") { const b = await rd(); return json(removeProduct(tenant, String(b.product_id || ""))); }
      if (path === "/shop/price-test" && request.method === "POST") return json(attemptPriceChange(tenant, await rd()));
      return json({ error: "unknown shop route" }, 404);
    }
    if (path === "/company") { const { COMPANY } = await import("./server/odai/store.mjs"); return json({ tenant_id: tenant, company: COMPANY, note: "synthetic demo brand standing in for TGDO per owner instruction; swap odai/config/company_profile.json when real data arrives" }); }
    if (path === "/objectives") {
    if (request.method === "GET") return json({ tenant_id: tenant, objectives: listObjectives(tenant) }); // WO-10R restore list
    let raw = ""; for await (const c of request) raw += c;
    const body = JSON.parse(raw || "{}");
    const statement = body.statement || body.text || body.objective || body.utterance; // WO-10R restore V38 body fields
    return json(await createObjective(tenant, String(statement || "").slice(0, 300)));
  }
  if (path.startsWith("/objectives/")) {
    const seg = path.split("/"); const oid = seg[2], action = seg[3];
    if (request.method === "POST" && action === "approve") {
      let raw = ""; for await (const c of request) raw += c;
      const { scope, cap } = JSON.parse(raw || "{}");
      return json(await approve(tenant, oid, String(scope), Number(cap) || 150));
    }
    if (request.method === "POST" && action === "resume") return json(await resume(tenant, oid));
    if (request.method === "POST" && action === "report") return json(finalReport(tenant, oid));
    if (request.method === "GET" && action === "report") return json(salesReport(tenant, oid));
    if (request.method === "POST" && action === "demo-sales") { let raw = ""; for await (const c of request) raw += c; return json(await setDemoSales(tenant, oid, JSON.parse(raw || "{}"))); }
    if (request.method === "POST" && action === "boost") { let raw = ""; for await (const c of request) raw += c; const { amount } = JSON.parse(raw || "{}"); return json(await requestBoost(tenant, oid, { amount })); }
    if (request.method === "POST" && action === "constraint") { let raw = ""; for await (const c of request) raw += c; const { organic_only } = JSON.parse(raw || "{}"); return json(await applyConstraint(tenant, oid, { organic_only })); }
    if (request.method === "GET" && !action) return json(await resume(tenant, oid));
  }
  if (path === "/modes") return json({ contract: "ui_modes_9_0", policy_version: POLICY_VERSION, unavailable_rule_sets: UNAVAILABLE_RULE_SETS, modes: ["user", "management", "security"], mode_change_grants_permission: false });
    if (path === "/registry" && request.method === "GET") return json({ tenant_id: tenant, ...registrySummary() }); // WO-A1: counts + version hash (no PII, no prose row dumps)
    if (path === "/intents" && request.method === "GET") {
      // registry minus internal fields (keywords stripped server-side). Data-driven; no prose in code.
      return json({ tenant_id: tenant, intents: publicIntents() });
    }
    if (path === "/intents/match" && request.method === "POST") {
      let raw = ""; for await (const c of request) raw += c;
      let body; try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "bad json" }, 400); }
      const utterance = String(body.utterance || "").slice(0, 300);
      const match = matchIntent(utterance);
      const autocreate = url.searchParams.get("autocreate"); // owner gate WO-09: only "true" launches, else side-effect-free match
      if (autocreate === "true" && match.intent && match.intent.engine === "objective" && match.intent.objective_template) {
        const created = await createObjective(tenant, match.intent.objective_template);
        return json({ tenant_id: tenant, launch: "autocreate", intent: match.intent, score: match.score, objective: created });
      }
      return json({ tenant_id: tenant, launch: "match-only", intent: match.intent, score: match.score });
    }
    if (path === "/view") {
      const mode = url.searchParams.get("mode");
      const authz = modeAccess(mode, { tenantId: tenant });   // staging demo session; production auth: WO-90-SEC-004
      if (!authz.ok) return json({ error: authz.reason }, 403);
      const body = mode === "user" ? await userView(tenant) : mode === "management" ? await managementView(tenant) : await securityView(tenant);
      return json({ mode, tenant_id: tenant, grants: authz.grants, data_mode: "TEST", ...body });
    }
    if (path === "/demo/start" && request.method === "POST") {
      let raw = ""; for await (const c of request) raw += c;
      const { objective } = JSON.parse(raw || "{}");
      return json({ tenant_id: tenant, ...await startRun(tenant, String(objective || "Sell FNYGlobal wellness products to 100 customers").slice(0, 300)) });
    }
    if (path === "/demo/approve" && request.method === "POST") {
      let raw = ""; for await (const c of request) raw += c;
      const { runId, approve, cap } = JSON.parse(raw || "{}");
      return json(await decideSpend(tenant, String(runId), !!approve, Number(cap) || 200));
    }
    if (path === "/catalog") return json({ tenant_id: tenant, review_mode: "QUARANTINE_REVIEW_REQUIRED", products: get(tenant).products.map((p) => ({ id: p.id, name: p.name, currency: p.currency, price: p.website_price, price_type: p.price_type, reseller_authorized: p.reseller_authorized, regulatory: p.regulatory_review_status, review_state: p.review_state })) });
    if (path === "/uploads/approve" && request.method === "POST") {
      if (!supabaseConfigured()) return json({ error: "upload approval requires Supabase mode", code: "SUPABASE_NOT_CONFIGURED" }, 501);
      let raw = ""; for await (const c of request) raw += c;
      let body; try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "bad json" }, 400); }
      const uploadId = String(body.upload_id || "");
      if (!/^[0-9a-fA-F-]{36}$/.test(uploadId)) return json({ error: "upload_id (uuid) required" }, 400);
      try { return json({ tenant_id: tenant, ...await approveUpload(tenant, uploadId) }); }
      catch (e) { const m = String(e?.message || e); return json({ error: m }, /42501|not authorized/i.test(m) ? 403 : 400); }
    }
    return json({ error: "unknown odai path" }, 404);
  } catch (e) { return json({ error: String(e?.message || e) }, 400); }
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
