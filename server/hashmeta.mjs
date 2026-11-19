/* AIVORA ⇄ Hashmeta connector bridge.
 * QW Page server acts as an MCP *client* against Hashmeta's streamable-http MCP
 * endpoint (https://app.hashmeta.ai/api/mcp). Auth: HASHMETA_API_TOKEN env var
 * (Bearer). Flow: initialize → notifications/initialized → tools/list →
 * tools/call on the discovered catalog/store tool.
 * Fallback: if no token or the connector fails, AIVORA generates the page itself
 * via qwen3.8-omni-flash (needs the Model Studio key). Pure functions returning
 * {status, type, body} — server.mjs does the sending.
 */

const DEFAULT_MCP_URL = "https://app.hashmeta.ai/api/mcp";
const TOOL_RX = /catalog|store|shop|ecommerce|e-commerce|landing|product.?page/i;

let session = null;   // mcp-session-id after initialize
let tools = null;     // cached tools/list

async function rpc(body, env, isNotification) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${env.hashmetaToken}`,
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(env.hashmetaUrl || DEFAULT_MCP_URL, {
    method: "POST", headers,
    body: JSON.stringify(isNotification ? { jsonrpc: "2.0", method: body.method, params: body.params ?? {} } : body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (!res.ok && res.status !== 202 && res.status !== 204)
    throw new Error(`hashmeta HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const raw = await res.text();
  if (isNotification || !raw.trim()) return null;
  const ctype = res.headers.get("content-type") || "";
  let payload = null;
  if (ctype.includes("event-stream")) {
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      try { const j = JSON.parse(s.slice(5).trim()); if (j.result || j.error) payload = j; } catch { /* frame */ }
    }
  } else {
    try { payload = JSON.parse(raw); } catch { throw new Error("hashmeta: unparseable response"); }
  }
  if (payload?.error) throw new Error(payload.error.message || "hashmeta rpc error");
  return payload?.result;
}

async function ensure(env) {
  if (session) return;
  await rpc({ jsonrpc: "2.0", id: "init", method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "aivora-page", version: "1.0" },
  } }, env);
  try { await rpc({ method: "notifications/initialized" }, env, true); } catch { /* optional */ }
}

async function listTools(env, force) {
  if (tools && !force) return tools;
  await ensure(env);
  const r = await rpc({ jsonrpc: "2.0", id: "tl", method: "tools/list", params: {} }, env);
  tools = r?.tools || [];
  return tools;
}

function buildStorePrompt(spec) {
  const items = Array.isArray(spec.products) ? spec.products.join("\n") : String(spec.products || "");
  const n = items.split("\n").map((x) => x.trim()).filter(Boolean).length;
  return `Generate an ecommerce product catalog page for the online store "${spec.storeName || "My Store"}". ` +
    `Products:\n${items.trim()}\nTarget market: ${spec.market || "Singapore"}. Page language: ${spec.language || "English"}. ` +
    `Requirements: single responsive mobile-first HTML page, hero with store name, EXACTLY ${n} product ` +
    `grid cards - one per product line above with its EXACT name and price, a WhatsApp enquiry button on ` +
    `every card, trust badges, footer. Do not skip or merge any product.`;
}

/* Map our generic spec onto whatever schema the discovered tool declares. */
function pickToolArgs(tool, spec) {
  const names = Object.keys(tool.inputSchema?.properties || {});
  const out = {};
  const setIf = (rxs, val) => {
    if (val == null) return false;
    const n = names.find((k) => rxs.some((r) => r.test(k)));
    if (!n) return false;
    out[n] = val; return true;
  };
  setIf([/prompt|query|brief|description|instruction/i], buildStorePrompt(spec));
  setIf([/store.?name|shop|brand/i], spec.storeName);
  setIf([/product|items|catalog|sku|offer/i], Array.isArray(spec.products) ? spec.products : String(spec.products || ""));
  setIf([/market|region|locale/i], spec.market || "Singapore");
  setIf([/lang/i], spec.language || "en");
  if (!names.length || (!Object.keys(out).length && names[0])) {
    if (names.length) out[names[0]] = buildStorePrompt(spec);
  }
  return out;
}

async function callCatalog(spec, env) {
  await listTools(env);
  const tool = (env.storeTool ? tools.find((t) => t.name === env.storeTool) : null)
    || tools.find((t) => TOOL_RX.test(t.name));
  if (!tool) throw new Error(`no catalog tool found; hashmeta tools: [${tools.map((t) => t.name).join(", ") || "none"}]`);
  const r = await rpc({ jsonrpc: "2.0", id: "call", method: "tools/call",
    params: { name: tool.name, arguments: pickToolArgs(tool, spec) } }, env);
  const text = (r?.content || []).map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c ?? ""))).join("\n").trim();
  if (r?.isError) throw new Error(`tool ${tool.name}: ${text.slice(0, 240) || "error"}`);
  return { tool: tool.name, result: text };
}

/* AIVORA composes the page itself (streaming chat completion, HTML extracted).
 * Thinking mode off + length discipline: page scaffolding does not need a long
 * reasoning chain, and omni's default thinking made generation run past 2 min. */
async function localGenerate(spec, env) {
  if (!env.modelStudioKey) return null;
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 100_000);
  let upstream;
  try {
    upstream = await fetch(`https://${env.workspace}.${env.region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${env.modelStudioKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.analyzeModel,
        enable_thinking: false,
        max_tokens: 3500,
        messages: [{ role: "user", content: buildStorePrompt(spec) + " Output ONLY a complete, compact single-file HTML document in one ```html fence (lean inline CSS, no comments, no JS)." }],
        modalities: ["text"], stream: true,
      }),
    });
  } catch (e) { clearTimeout(kill); throw e; }
  if (!upstream.ok) { clearTimeout(kill); return null; }
  let acc = "", buf = "";
  const dec = new TextDecoder();
  try {
  for await (const chunk of upstream.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") continue;
      try { const j = JSON.parse(p); acc += j.choices?.[0]?.delta?.content || ""; } catch { /* partial */ }
    }
  }
  } finally { clearTimeout(kill); }
  let html = acc.match(/```(?:html)?\s*([\s\S]*?)```/i)?.[1];
  if (!html) {
    // truncated stream: the closing fence never arrived — salvage the document
    html = acc.replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "");
    if (!/<html|<!doctype/i.test(html)) return null;
    if (!/<\/html>/i.test(html)) html += "\n</body>\n</html>";
  }
  return { tool: "aivora-local", result: html };
}

const J = (v) => ({ status: 200, type: "application/json; charset=utf-8", body: JSON.stringify(v) });
const E = (status, msg) => ({ status, type: "application/json; charset=utf-8", body: JSON.stringify({ error: msg }) });

/* Streaming generate: keep bytes flowing (heartbeat) so the gateway's ~30s
   buffered-response timeout never fires; the final event carries the JSON.
   Layered deadlines: hashmeta tool ≤70s, then local builder ≤110s. */
async function withTimeout(p, ms, label, onMs) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })]);
  } catch (e) { onMs?.(); throw e; }
  finally { clearTimeout(t); }
}

export const BUILD = "v18-stream";

export async function storeRun(spec, env) {
  if (!String(spec?.products || "").trim() && !String(spec?.storeName || "").trim())
    return { error: "storeName or products required" };
  let err = null;
  if (env.hashmetaToken) {
    try {
      const out = await withTimeout(callCatalog(spec, env), 70000, "hashmeta tool");
      return { build: BUILD, mode: "hashmeta", tool: out.tool, result: out.result };
    } catch (e) { err = e.message; }
  }
  try {
    const out = await withTimeout(localGenerate(spec, env), 110000, "local generation");
    if (out) return { build: BUILD, mode: env.hashmetaToken ? "aivora-fallback" : "aivora-local", tool: out.tool, result: out.result, note: err || undefined };
  } catch (e) {
    err = (err ? err + " | " : "") + e.message;
    try { } catch { /* */ }
  }
  return { error: err || "Generation timed out — shorten the product list and retry" };
}

export async function storeDiag(env) {
  let toolList = null, error = null;
  if (env.hashmetaToken) {
    try { toolList = (await listTools(env, true)).map((t) => ({ name: t.name, desc: String(t.description || "").slice(0, 120) })); }
    catch (e) { error = e.message; }
  }
  return J({ build: BUILD, hashmeta_token: !!env.hashmetaToken, mcp_session: !!session, tools: toolList, error: error || undefined });
}
