/* odai/db.mjs — Supabase-compatible PolarDB access (server-side only).
 *
 * Request-scoped, RLS-enforced data layer:
 *   • Normal reads/writes use the signed-in user's Supabase access token via a
 *     per-request client (AsyncLocalStorage), so PostgREST runs as `authenticated`
 *     and Postgres enforces the role-based RLS policies for that user.
 *   • Anonymous requests are DENIED (no token → auth error; policies also deny anon).
 *   • The service-role key is reserved for isolated admin operations ONLY
 *     (demo seeding / migrations) and is read from a server-side secret env.
 *   • In-memory storage is used ONLY in explicit offline mode (AIVORA_MEMORY_MODE=1).
 *     When Supabase is configured but unreachable, errors are surfaced, not swallowed.
 * The app never runs DDL here; the browser never sees any of this; keys are never logged.
 */
import { createClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";

const BROKER_URL = "http://127.0.0.1:9001";
const BROKER_PLACEHOLDER_KEY = "qwenwork-runtime-broker";

/** Per-request Supabase bearer (the signed-in user's access token). */
export const requestCtx = new AsyncLocalStorage();
export function runWithToken(token, fn) { return requestCtx.run({ token: token || null }, fn); }

const OPS = new Set(["seed_catalog", "load_products", "insert_run", "insert_trace", "insert_receipt",
  "upsert_approval", "insert_order", "insert_handoff", "insert_ledger", "insert_profit",
  "read_latest_run", "read_receipts", "read_trace", "read_products", "runstate"]);

class DbUnavailable extends Error { constructor(m) { super(m || "Database service is unavailable"); this.code = "DATABASE_UNAVAILABLE"; } }
class DbAuthRequired extends Error { constructor() { super("Authentication required for Supabase mode"); this.code = "AUTH_REQUIRED"; } }
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

export const isOffline = () => process.env.AIVORA_MEMORY_MODE === "1";
const clientKey = () => process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || null;
/** Hosted Supabase mode is on only when URL + a client key + instance id are all present. */
export const supabaseConfigured = () => !!(process.env.SUPABASE_URL && clientKey() && process.env.SUPABASE_INSTANCE_ID);

function baseOpts(headers) {
  return { global: { headers }, auth: { persistSession: false, autoRefreshToken: false } };
}

/** Request-scoped client for normal operations: anon key + the signed-in user's bearer. */
function userClient(token) {
  const h = { Authorization: `Bearer ${token}`, "X-Instance-ID": process.env.SUPABASE_INSTANCE_ID };
  return createClient(process.env.SUPABASE_URL, clientKey(), baseOpts(h));
}
/** Service-role client — reserved for admin ops (seed/migrate). Never for normal requests. */
function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new DbUnavailable("SUPABASE_SERVICE_ROLE_KEY not configured for admin operation");
  return createClient(process.env.SUPABASE_URL, key, baseOpts({ "X-Instance-ID": process.env.SUPABASE_INSTANCE_ID }));
}
/** Broker client — legacy production path when SUPABASE_* vars are absent. */
function brokerClient() { return createClient(BROKER_URL, BROKER_PLACEHOLDER_KEY, baseOpts({})); }

/** Resolve the client for the current request. Offline → error (callers must guard). */
function currentClient() {
  if (isOffline()) throw new DbUnavailable("offline mode: memory store is authoritative");
  if (supabaseConfigured()) {
    const token = requestCtx.getStore()?.token;
    if (!token) throw new DbAuthRequired();          // anonymous request in Supabase mode → denied
    return userClient(token);
  }
  return brokerClient();                              // legacy broker path
}

async function op(client, name, fn) {
  try {
    const { data, error } = await fn(client);
    if (error) throw new DbOp(error, name);
    return data;
  } catch (e) { if (e instanceof DbOp || e instanceof DbUnavailable || e instanceof DbAuthRequired) throw e; throw new DbOp(e, name); }
}

/* availability: offline → false (memory). Configured-but-failing → surface (throw).
   Legacy broker failing → false (memory), preserving prior behavior. */
let avail;
export async function dbAvailable() {
  if (isOffline()) return (avail = false);
  const supa = supabaseConfigured();
  if (!supa && avail !== undefined) return avail;     // broker probe cached per process
  let client;
  try { client = currentClient(); }
  catch (e) { if (supa) throw e; return (avail = false); }  // configured + no token → surface
  try {
    await op(client, "read_products", (s) => s.from("odai_product").select("sku", { count: "exact", head: true }).limit(1));
    if (!supa) avail = true;
    return true;
  } catch (e) {
    if (supa) throw e;                                 // Supabase configured but unavailable → surface
    if (!supa) { avail = false; if (!(e instanceof DbUnavailable)) console.error("db probe:", e.diagnostic); }
    return false;
  }
}

/* ---- admin op: demo seeding runs under the service role (bypasses RLS by design) ---- */
export async function seedCatalog(tenantId, items) {
  const s = serviceClient();
  const existing = await op(s, "load_products", (c) => c.from("odai_product").select("sku", { count: "exact", head: true }).eq("tenant_id", tenantId));
  if ((existing?.count ?? 0) > 0) return { seeded: false };
  const rows = items.map((p) => ({ tenant_id: tenantId, sku: p.id, name: p.name, category: p.category, package: p.package,
    currency: p.currency, website_price: p.website_price, price_type: p.price_type, reseller_authorized: p.reseller_authorized,
    regulatory_review_status: p.regulatory_review_status, fulfillment_mode: p.fulfillment_mode,
    marketing_claims_approved: p.marketing_claims_approved, review_state: "QUARANTINED", provenance: p }));
  await op(s, "seed_catalog", (c) => c.from("odai_product").upsert(rows));
  return { seeded: true, count: rows.length };
}

/* ---- normal, request-scoped (RLS-enforced) operations ---- */
export const loadProducts = (tenantId) => op(currentClient(), "load_products", (s) => s.from("odai_product").select("*").eq("tenant_id", tenantId).order("sku"));

export const insertRun = (t) => op(currentClient(), "insert_run", (s) => s.from("odai_run").upsert(t));
export const insertTrace = (t) => op(currentClient(), "insert_trace", (s) => s.from("odai_trace").insert(t));
export const insertReceipt = (t) => op(currentClient(), "insert_receipt", (s) => s.from("odai_receipt").upsert(t));
export const upsertApproval = (t) => op(currentClient(), "upsert_approval", (s) => s.from("odai_spend_approval").upsert(t));
export const insertOrder = (t) => op(currentClient(), "insert_order", (s) => s.from("odai_order").upsert(t));
export const insertHandoff = (t) => op(currentClient(), "insert_handoff", (s) => s.from("odai_fulfillment_handoff").upsert(t));
export const insertLedger = (rows) => op(currentClient(), "insert_ledger", (s) => s.from("odai_ledger_entry").insert(rows));
export const insertProfit = (t) => op(currentClient(), "insert_profit", (s) => s.from("odai_profit_snapshot").insert(t));

export const readLatestRun = (tenantId) => op(currentClient(), "read_latest_run", (s) => s.from("odai_run").select("*").eq("tenant_id", tenantId).order("started_at", { ascending: false }).limit(1).maybeSingle());
export const setRunState = (tenantId, runId, state) => op(currentClient(), "runstate", (s) => s.from("odai_run").update({ state }).eq("tenant_id", tenantId).eq("run_id", runId));
export const readReceipts = (tenantId, runId) => op(currentClient(), "read_receipts", (s) => s.from("odai_receipt").select("*").eq("tenant_id", tenantId).eq("run_id", runId).order("beat"));
export const readTrace = (tenantId, last = 40) => op(currentClient(), "read_trace", (s) => s.from("odai_trace").select("*").eq("tenant_id", tenantId).order("seq", { ascending: false }).limit(last));

/* ---- Supabase Storage (private bucket) for composer attachments ---- */
export const UPLOAD_BUCKET = "odai-uploads";
export async function putUpload({ tenantId, uploadId, filename, body, contentType }) {
  const path = `${tenantId}/${uploadId}/${filename}`;
  await op(currentClient(), "insert_receipt", (s) => s.storage.from(UPLOAD_BUCKET).upload(path, body, { contentType, upsert: false }));
  await op(currentClient(), "insert_run", (s) => s.from("odai_upload").insert({
    tenant_id: tenantId, upload_id: uploadId, storage_bucket: UPLOAD_BUCKET, storage_path: path,
    name: filename, mime: contentType, size: body?.byteLength ?? (body?.length ?? 0), approved: false }));
  return { bucket: UPLOAD_BUCKET, path };
}

/** Approve a private upload (owner/admin only — enforced by the odai_approve_upload RPC). */
export async function approveUpload(tenantId, uploadId) {
  const s = currentClient();
  const { data, error } = await s.rpc("odai_approve_upload", { p_tenant: tenantId, p_upload_id: uploadId });
  if (error) throw new DbOp(error, "approve_upload");
  return { approved: !!data };
}
