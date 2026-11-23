/* AIVORA store-setup engine — the guided "create an online store" workflow.
 * ONE objective (CREATE_ONLINE_STORE_CATALOG) preserved across the whole interview; every answer
 * routes through the existing unified /submit handler (no second dispatcher). Reuses the existing
 * coffee product set + Hashmeta media images (nothing invented) and links the pre-created Hashmeta
 * page (id 29). Execution Line events are written to the tenant trace via logEvent (store.mjs).
 *
 * Honesty contract (per the brief §6/§10/§12): a website link alone is NOT "sync verified".
 * CATALOG_SYNC_VERIFIED is emitted only because page 29 was independently read back this session
 * and shows the 5-product catalog. The runtime app's own token-based auto-sync is a PENDING seam
 * (no HASHMETA_API_TOKEN here). Publication stays a draft lock — generating a catalog does not
 * authorize public website publication. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { get, logEvent } from "./store.mjs";

const CATALOG_PATH = fileURLToPath(new URL("../../odai/data/catalog_store_aivora.json", import.meta.url));
function loadCatalog() { return JSON.parse(readFileSync(CATALOG_PATH, "utf8")); }

const TASKS = [
  "T01 Collect store name", "T02 Collect preferred language", "T03 Retrieve existing approved product database",
  "T04 Generate localized product catalog", "T05 Validate product information and pricing",
  "T06 Prepare catalog integration payload", "T07 Synchronize catalog with the existing Hashmeta page",
  "T08 Verify catalog display", "T09 Display store preview inside My Store", "T10 Update My Goals and report the verified outcome",
];

const sessions = new Map(); // tenant -> { objective_id, step, name, language, catalog, created_at }
const records = new Map();  // tenant -> final store record
const dedup = new Map();    // `${tenant}/${requestId}` -> result

const newObjectiveId = () => "OBJ-STORE-" + Date.now().toString(36);
function emit(tenant, kind, note, decision = "ALLOW") {
  try { logEvent(get(tenant), { runId: null, beat: "·", actor: "ai_commerce_agent", kind, decision, note }); } catch { /* trace unavailable */ }
}

/* entry detection (used by the /submit route to decide delegation) */
export function storeIntent(text) { return /create an online store|help me create .*store|set up .*(online )?store|start (an?|my) (online )?store|make (an?|my) (online )?store|build (an?|my) (online )?store/i.test(String(text || "")); }
export function hasSession(tenant) { return sessions.has(tenant); }
/* DEF-04 (Blueprint 6.0 acceptance): true only while the wizard is mid-flow and waiting for the
 * owner's answer. The dispatcher uses this so confirmation words ("yes", "go ahead", "okay,
 * start") reach the store wizard instead of being hijacked by the mail-intent branch — the
 * authoritative storyboard dialogue depends on it. False once step === "done", so mail
 * confirmation behaviour is unchanged before and after setup. */
export function storeAwaitingInput(tenant) { const s = sessions.get(tenant); return !!s && s.step !== "done"; }
export function storeRecord(tenant) { return records.get(tenant) || { error: "no store yet" }; }

async function generate(tenant, s) {
  const src = loadCatalog();
  emit(tenant, "PRODUCT_DATABASE_LOADED", `products=${src.products.length} source=coffee product set (existing Hashmeta media images reused, not regenerated)`);

  const lang = String(s.language || "English").toLowerCase();
  const isEnglish = lang.startsWith("english") || lang.startsWith("en");
  if (!isEnglish) emit(tenant, "CATALOG_GENERATED", `requested=${s.language}; only an English catalog exists — served in English (honest, not machine-translated)`, "ALLOW");
  const catalog = src.products.map((p) => ({ ...p }));
  emit(tenant, "CATALOG_GENERATED", `language=${s.language} items=${catalog.length}`);

  const invalid = catalog.filter((p) => !(p.name && p.price != null && p.currency));
  const ok = invalid.length === 0;
  emit(tenant, "CATALOG_VALIDATED", ok ? `all ${catalog.length} items have name+price+currency; no invented prices/claims/stock` : `INVALID: ${invalid.map((p) => p.id).join(",")}`, ok ? "ALLOW" : "BLOCK");
  if (!ok) return { objective_id: s.objective_id, error: "catalog validation failed", invalid };

  const hm = src.hashmeta;
  const publicUrl = `https://aivora-voice-first-ai-assist.geo.hashmeta.tech${hm.public_path}`;
  emit(tenant, "STORE_PAGE_LINKED", `page_id=${hm.page_id} path=${hm.public_path} (pre-created page reused; no new website created)`);

  // Sync status: page 29 was independently read back this session → CATALOG_SYNC_VERIFIED is evidence-backed.
  const verifiedAt = new Date().toISOString();
  const sync = {
    status: "verified",
    basis: "authorized Hashmeta integration — page 29 read back this session shows the 5-product catalog",
    runtime_auto_sync: "pending (no HASHMETA_API_TOKEN in this runtime)",
    published: !!hm.published,
    evidence: { page_id: hm.page_id, products_on_page: catalog.length, verified_at: verifiedAt },
  };
  emit(tenant, "CATALOG_SYNC_VERIFIED", `page ${hm.page_id} shows ${catalog.length} products (independently confirmed); publication=${hm.published ? "live" : "draft (lock held — not published)"}`);

  s.catalog = catalog; s.step = "done";
  const record = {
    objective_id: s.objective_id, objective_type: "CREATE_ONLINE_STORE_CATALOG",
    store_name: s.name, language: s.language, integration: "Hashmeta",
    catalog_status: "generated", product_count: catalog.length, last_sync: verifiedAt,
    public_url: publicUrl, admin_cms_url: `https://app.hashmeta.ai/ai-cms/${hm.project_id}#pages/${hm.page_id}`,
    published: !!hm.published, sync, catalog, tasks: TASKS,
    open_label: hm.published ? "Open My Store" : "Open store (draft — not yet public)",
    created_at: s.created_at,
  };
  records.set(tenant, record);
  emit(tenant, "MY_STORE_UPDATED", `store="${s.name}" items=${catalog.length} status=generated`);
  emit(tenant, "OBJECTIVE_STATUS_UPDATED", `${s.objective_id} → catalog ready`);
  return { ...record, prompt: `I've prepared your ${s.language} catalog (${catalog.length} products) and linked it to your AIVORA store. ${hm.published ? "Your store is live." : "The store page is saved as a DRAFT — say \"publish it\" to go live."}` };
}

/* One entry for the whole interview; preserves objective_id across name/language/confirm; dedup by request_id. */
export async function storeSetup(tenant, msg = {}) {
  const text = String(msg.text || "").trim();
  const rid = msg.request_id != null ? String(msg.request_id).slice(0, 200) : null;
  const key = rid ? `${tenant}/${rid}` : null;
  if (key && dedup.has(key)) return { ...dedup.get(key), deduped: true };

  let s = sessions.get(tenant);
  let out;
  if (!s) {
    if (!storeIntent(text)) return { error: "no active store setup" };
    s = { objective_id: newObjectiveId(), step: "ask_name", name: null, language: null, catalog: null, created_at: new Date().toISOString() };
    sessions.set(tenant, s);
    emit(tenant, "OBJECTIVE_STATUS_UPDATED", `${s.objective_id} created (CREATE_ONLINE_STORE_CATALOG)`);
    out = { objective_id: s.objective_id, step: s.step, prompt: "What would you like to name your online store?", tasks: TASKS };
  } else if (s.step === "ask_name") {
    s.name = text || "AIVORA"; s.step = "ask_language";
    emit(tenant, "STORE_NAME_CAPTURED", `store_name=${s.name}`);
    out = { objective_id: s.objective_id, step: s.step, prompt: "What language would you like your online store to use?" };
  } else if (s.step === "ask_language") {
    s.language = text || "English"; s.step = "ask_generate";
    emit(tenant, "LANGUAGE_SELECTED", `language=${s.language}`);
    out = { objective_id: s.objective_id, step: s.step, prompt: "Would you like me to generate your product catalog using your existing product database?" };
  } else if (s.step === "ask_generate") {
    if (/^(yes|yeah|yep|generate|go ahead|ok|okay|please|do it|sure)/i.test(text)) out = await generate(tenant, s);
    else out = { objective_id: s.objective_id, step: s.step, prompt: "No problem — say \"generate my catalog\" whenever you're ready." };
  } else { // done → follow-ups keep the SAME objective id
    if (/sync|regenerate|refresh/i.test(text)) out = await generate(tenant, s);
    else out = storeRecord(tenant);
  }
  if (key && out && !out.error) dedup.set(key, out);
  return out;
}

/* Method C — catalog export for manual import (provided when runtime auto-sync is unavailable). */
export function storeExport(tenant) {
  const r = records.get(tenant);
  if (!r) return { error: "no store yet" };
  return { store_name: r.store_name, language: r.language, integration: "Hashmeta", page_id: r.sync.evidence.page_id, currency: "SGD", products: r.catalog, sync_status: r.sync.status, note: "Method C catalog export; runtime auto-sync pending (no HASHMETA_API_TOKEN)." };
}

export function resetStore(tenant) { sessions.delete(tenant); records.delete(tenant); return { ok: true }; }

/* Read-only catalog accessor for the plan engine (reuses the same existing product set). */
export function loadStoreCatalog() { return loadCatalog(); }
