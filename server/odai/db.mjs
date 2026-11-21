/* odai/db.mjs — Supabase-compatible PolarDB access (server-side only,
 * lazy dual-mode client: Broker v2 in production, SUPABASE_* vars for local
 * verification). The app never runs DDL; the browser never sees any of this. */
import { createClient } from "@supabase/supabase-js";

const BROKER_URL = "http://127.0.0.1:9001";
const BROKER_PLACEHOLDER_KEY = "qwenwork-runtime-broker";

const OPS = new Set(["seed_catalog", "load_products", "insert_run", "insert_trace", "insert_receipt",
  "upsert_approval", "insert_order", "insert_handoff", "insert_ledger", "insert_profit",
  "read_latest_run", "read_receipts", "read_trace", "read_products"]);

class DbUnavailable extends Error { constructor() { super("Database service is unavailable"); this.code = "DATABASE_UNAVAILABLE"; } }
class DbOp extends Error {
  constructor(raw, operation) { super("Database operation failed"); this.code = "DATABASE_OPERATION_FAILED"; this.diagnostic = diag(raw, operation); }
}
const CODE_RX = /^[A-Z0-9_]{1,32}$/;
function diag(raw, op) {
  const code = typeof raw?.code === "string" ? raw.code.toUpperCase() : "UNKNOWN";
  const safe = CODE_RX.test(code) ? code : "UNKNOWN";
  const status = Number.isInteger(raw?.status) && raw.status >= 400 && raw.status <= 599 ? raw.status : undefined;
  let category = "operation_failed";
  if (status === 401) category = "authentication_failed";
  else if (status === 403 || safe === "42501") category = "permission_denied";
  else if (["42P01", "42703", "PGRST205"].includes(safe)) category = "schema_mismatch";
  else if (status === 409 || ["23503", "23505"].includes(safe)) category = "conflict";
  else if (status === 429) category = "rate_limited";
  else if (safe === "57014" || raw?.name === "AbortError") category = "timeout";
  else if ((status && status >= 500) || raw?.name === "TypeError") category = "upstream_unavailable";
  return { category, code: safe, operation: OPS.has(op) ? op : "unknown", ...(status ? { status } : {}) };
}

let client;
function klien() {
  if (client) return client;
  const legacy = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY, instanceId: process.env.SUPABASE_INSTANCE_ID };
  const n = Object.values(legacy).filter(Boolean).length;
  if (n !== 0 && n !== 3) throw new DbUnavailable();
  const external = n === 3;
  client = createClient(external ? legacy.url : BROKER_URL, external ? legacy.key : BROKER_PLACEHOLDER_KEY, {
    global: { headers: external ? { "X-Instance-ID": legacy.instanceId } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
async function op(name, fn) {
  try {
    const { data, error } = await fn(klien());
    if (error) throw new DbOp(error, name);
    return data;
  } catch (e) { if (e instanceof DbOp || e instanceof DbUnavailable) throw e; throw new DbOp(e, name); }
}

/* availability probe (cached per process; DB optional — memory store remains the fallback) */
let avail; 
export async function dbAvailable() {
  /* Explicit memory/mock mode (AIVORA_MEMORY_MODE=1): skip the broker availability probe
   * entirely and treat the in-memory store as authoritative, so view/objective projections
   * respond promptly with no local broker. Default (unset) preserves the DB-first probe,
   * leaving broker-backed production behavior unchanged. */
  if (process.env.AIVORA_MEMORY_MODE === "1") return (avail = false);
  if (avail !== undefined) return avail;
  try { await op("read_products", (s) => s.from("odai_product").select("sku", { count: "exact", head: true }).limit(1)); avail = true; }
  catch (e) { avail = false; if (!(e instanceof DbUnavailable)) console.error("db probe:", e.diagnostic); }
  return avail;
}

export async function seedCatalog(tenantId, items) {
  const existing = await op("load_products", (s) => s.from("odai_product").select("sku", { count: "exact", head: true }).eq("tenant_id", tenantId));
  if ((existing?.count ?? 0) > 0) return { seeded: false };
  const rows = items.map((p) => ({ tenant_id: tenantId, sku: p.id, name: p.name, category: p.category, package: p.package,
    currency: p.currency, website_price: p.website_price, price_type: p.price_type, reseller_authorized: p.reseller_authorized,
    regulatory_review_status: p.regulatory_review_status, fulfillment_mode: p.fulfillment_mode,
    marketing_claims_approved: p.marketing_claims_approved, review_state: "QUARANTINED", provenance: p }));
  await op("seed_catalog", (s) => s.from("odai_product").upsert(rows));
  return { seeded: true, count: rows.length };
}
export const loadProducts = (tenantId) =>
  op("load_products", (s) => s.from("odai_product").select("*").eq("tenant_id", tenantId).order("sku"));

export const insertRun = (t) => op("insert_run", (s) => s.from("odai_run").upsert(t));
export const insertTrace = (t) => op("insert_trace", (s) => s.from("odai_trace").insert(t));
export const insertReceipt = (t) => op("insert_receipt", (s) => s.from("odai_receipt").upsert(t));
export const upsertApproval = (t) => op("upsert_approval", (s) => s.from("odai_spend_approval").upsert(t));
export const insertOrder = (t) => op("insert_order", (s) => s.from("odai_order").upsert(t));
export const insertHandoff = (t) => op("insert_handoff", (s) => s.from("odai_fulfillment_handoff").upsert(t));
export const insertLedger = (rows) => op("insert_ledger", (s) => s.from("odai_ledger_entry").insert(rows));
export const insertProfit = (t) => op("insert_profit", (s) => s.from("odai_profit_snapshot").insert(t));

export const readLatestRun = (tenantId) =>
  op("read_latest_run", (s) => s.from("odai_run").select("*").eq("tenant_id", tenantId).order("started_at", { ascending: false }).limit(1).maybeSingle());
export const setRunState = (tenantId, runId, state) =>
  op("runstate", (s) => s.from("odai_run").update({ state }).eq("tenant_id", tenantId).eq("run_id", runId));
export const readReceipts = (tenantId, runId) =>
  op("read_receipts", (s) => s.from("odai_receipt").select("*").eq("tenant_id", tenantId).eq("run_id", runId).order("beat"));
export const readTrace = (tenantId, last = 40) =>
  op("read_trace", (s) => s.from("odai_trace").select("*").eq("tenant_id", tenantId).order("seq", { ascending: false }).limit(last));
