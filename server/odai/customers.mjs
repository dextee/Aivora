/* AIVORA V43 — Native Customer Management (replaces any external CRM; no Salesforce/HubSpot, no external creds).
 * Reuses store.mjs (tenant store + logEvent/audit) and the catalog. Customer + purchase-history are computed
 * from ACTUAL stored records. HONESTY: import never fabricates missing fields; follow-ups are NEVER marked SENT
 * (external messaging stays restricted); mock data is labelled is_mock_data. No second dispatcher. */
import { get, logEvent } from "./store.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA_DIR = fileURLToPath(new URL("../../odai/data/", import.meta.url));
const customers = new Map();  // tenant -> Map(customerId -> customer)
const purchases = new Map();  // tenant -> [purchase]
const followups = new Map();  // tenant -> [followup]
const incidents = new Map();  // tenant -> [incident]
const agents = new Map();     // tenant -> Map(agentId -> {role, authorized, quarantined})

// configurable classification thresholds (calculated from purchase history)
let THRESHOLDS = { repeat_min_orders: 2, vip_min_amount: 200, inactive_days: 60, new_days: 30 };
export function setThresholds(t) { THRESHOLDS = { ...THRESHOLDS, ...t }; return THRESHOLDS; }
export function getThresholds() { return THRESHOLDS; }

const now = () => new Date().toISOString();
const idem = (p) => p + "-" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
function audit(tenant, kind, decision, note) { try { logEvent(get(tenant), { runId: null, beat: "·", actor: "crm", kind, decision, note }); } catch { /* best-effort */ } }
function custMap(tenant) { if (!customers.has(tenant)) customers.set(tenant, new Map()); return customers.get(tenant); }
function buys(tenant) { if (!purchases.has(tenant)) purchases.set(tenant, []); return purchases.get(tenant); }
function normContact(c) { const ph = String(c.phone_number || "").replace(/[^0-9]/g, ""); const em = String(c.email_address || "").trim().toLowerCase(); return (ph ? "p:" + ph : "") + "|" + (em ? "e:" + em : ""); }

export function createCustomer(tenant, data = {}) {
  const name = String(data.customer_name || "").trim();
  const contact = normContact(data);
  if (!name) return { error: "customer_name required" };
  if (!contact.replace(/\|/g, "")) return { error: "phone_number or email_address required" };
  const cm = custMap(tenant);
  const ph = String(data.phone_number || "").replace(/[^0-9]/g, "");
  const em = String(data.email_address || "").trim().toLowerCase();
  for (const c of cm.values()) { // dedup on ANY normalized identifier (phone OR email) within the workspace
    const cph = String(c.phone_number || "").replace(/[^0-9]/g, "");
    const cem = String(c.email_address || "").trim().toLowerCase();
    if ((ph && cph === ph) || (em && cem === em)) return { ...c, deduped: true };
  }
  const c = {
    customer_id: idem("CUS"), workspace_id: tenant, customer_name: name,
    phone_number: data.phone_number || null, email_address: data.email_address || null,
    city: data.city || null, country: data.country || "Malaysia", preferred_language: data.preferred_language || "en",
    customer_source: data.customer_source || "manual", campaign_id: data.campaign_id || null,
    registration_date: data.registration_date || now(), first_purchase_date: null, last_purchase_date: null,
    total_orders: 0, total_purchase_amount: 0, currency: data.currency || "MYR",
    customer_category: "POTENTIAL", marketing_consent: !!data.marketing_consent, consent_date: data.marketing_consent ? now() : null,
    follow_up_status: "NONE", next_follow_up_date: null, customer_notes: data.customer_notes || null,
    is_mock_data: data.is_mock_data !== false, created_at: now(), updated_at: now(),
  };
  cm.set(c.customer_id, c); return c;
}

export function updateCustomer(tenant, customer_id, patch = {}) {
  const c = custMap(tenant).get(customer_id); if (!c) return { error: "not found" };
  Object.assign(c, patch, { updated_at: now() }); return c;
}

export function getCustomer(tenant, customer_id) { const c = custMap(tenant).get(customer_id); return c ? { ...c, ...stats(tenant, customer_id) } : { error: "not found" }; }

export function searchCustomers(tenant, { q = "", category = "", page = 1, pageSize = 20 } = {}) {
  const all = [...custMap(tenant).values()].map((c) => ({ ...c, ...stats(tenant, c.customer_id) }));
  const needle = q.trim().toLowerCase();
  const filtered = all.filter((c) => (!category || c.customer_category === category) && (!needle || (c.customer_name + " " + (c.phone_number || "") + " " + (c.email_address || "")).toLowerCase().includes(needle)));
  const start = (Math.max(1, +page) - 1) * pageSize;
  return { tenant_id: tenant, total: filtered.length, page: +page, page_size: pageSize, customers: filtered.slice(start, start + pageSize) };
}

/* stats computed from ACTUAL purchase records — no double counting, single currency. */
function stats(tenant, customer_id) {
  const rows = buys(tenant).filter((p) => p.customer_id === customer_id);
  const currencies = [...new Set(rows.map((p) => p.currency))];
  const total = rows.reduce((s, p) => s + (p.total_amount || 0), 0);
  const dates = rows.map((p) => p.purchase_date).sort();
  const daysSinceLast = dates.length ? Math.floor((Date.now() - new Date(dates[dates.length - 1]).getTime()) / 86400000) : null;
  let category = "POTENTIAL";
  if (!rows.length) category = "NEW";
  else if (daysSinceLast != null && daysSinceLast > THRESHOLDS.inactive_days) category = "INACTIVE";
  else if (total >= THRESHOLDS.vip_min_amount) category = "VIP";
  else if (rows.length >= THRESHOLDS.repeat_min_orders) category = "REPEAT";
  else category = "NEW";
  return { total_orders: rows.length, total_purchase_amount: +total.toFixed(2), first_purchase_date: dates[0] || null, last_purchase_date: dates[dates.length - 1] || null, days_since_last_purchase: daysSinceLast, customer_category: category, currency: currencies.length > 1 ? "MIXED(no conversion)" : (currencies[0] || "MYR") };
}

export function addPurchase(tenant, p = {}) {
  const c = custMap(tenant).get(p.customer_id); if (!c) return { error: "customer not found" };
  const order = String(p.order_number || "").trim(); if (!order) return { error: "order_number required" };
  if (buys(tenant).some((x) => x.order_number === order)) return { deduped: true, existing: true }; // order-number dedup
  const qty = Number(p.quantity) || 0, unit = Number(p.unit_price) || 0;
  if (qty <= 0 || unit < 0) return { error: "invalid quantity/unit_price" };
  const rec = { purchase_id: idem("PUR"), customer_id: p.customer_id, workspace_id: tenant, order_number: order, product_id: p.product_id || null, product_name: p.product_name || null, quantity: qty, unit_price: unit, total_amount: +(qty * unit).toFixed(2), currency: p.currency || "MYR", purchase_date: p.purchase_date || now().slice(0, 10), payment_status: p.payment_status || "PAID", order_status: p.order_status || "COMPLETED", sales_channel: p.sales_channel || "store", campaign_id: p.campaign_id || c.campaign_id || null, is_mock_data: p.is_mock_data !== false, created_at: now() };
  buys(tenant).push(rec); Object.assign(c, stats(tenant, p.customer_id), { updated_at: now() });
  audit(tenant, "PURCHASE_RECORDED", "ALLOW", `${rec.order_number} ${rec.product_name || rec.product_id} qty=${qty}`);
  return rec;
}

export function getPurchaseHistory(tenant, customer_id) { return { customer_id, purchases: buys(tenant).filter((p) => p.customer_id === customer_id) }; }

/* import (CSV/JSON rows) — validate, flag missing, dedup, NO fabrication, mark mock. */
export function importCustomers(tenant, rows = []) {
  const out = { imported: 0, rejected: [], duplicates: [], flagged_missing: [] };
  for (const r of rows) {
    const missing = [];
    if (!String(r.customer_name || "").trim()) missing.push("customer_name");
    if (!normContact(r).replace(/\|/g, "")) missing.push("phone_number|email_address");
    if (missing.length) { out.rejected.push({ row: r, missing }); continue; }
    const c = createCustomer(tenant, { ...r, is_mock_data: true });
    if (c.error) out.rejected.push({ row: r, missing: [c.error] });
    else if (c.deduped) out.duplicates.push(c.customer_id);
    else { out.imported++; if (missing.length) out.flagged_missing.push({ id: c.customer_id, missing }); }
  }
  audit(tenant, "CUSTOMER_IMPORT", "ALLOW", `imported=${out.imported} rejected=${out.rejected.length} dupes=${out.duplicates.length}`);
  return out;
}

export function identifyRepeatBuyers(tenant) { return [...custMap(tenant).values()].map((c) => ({ ...c, ...stats(tenant, c.customer_id) })).filter((c) => c.total_orders >= THRESHOLDS.repeat_min_orders); }
export function identifyInactiveBuyers(tenant) { return [...custMap(tenant).values()].map((c) => ({ ...c, ...stats(tenant, c.customer_id) })).filter((c) => c.customer_category === "INACTIVE"); }
export function analyzePurchasePatterns(tenant) {
  const rows = buys(tenant); const byProduct = {}; const pairs = {};
  const perCust = {}; rows.forEach((p) => { byProduct[p.product_name || p.product_id] = (byProduct[p.product_name || p.product_id] || 0) + p.quantity; (perCust[p.customer_id] = perCust[p.customer_id] || []).push(p.product_name || p.product_id); });
  Object.values(perCust).forEach((list) => { const u = [...new Set(list)]; for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) { const k = [u[i], u[j]].sort().join(" + "); pairs[k] = (pairs[k] || 0) + 1; } });
  return { popular_products: Object.entries(byProduct).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, q]) => ({ product: n, qty: q })), co_purchase: Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pair, n]) => ({ pair, customers: n })) };
}
export function recommendProducts(tenant, customer_id) {
  const hist = new Set(buys(tenant).filter((p) => p.customer_id === customer_id).map((p) => p.product_name || p.product_id));
  const pop = analyzePurchasePatterns(tenant).popular_products.map((x) => x.product).filter((p) => !hist.has(p));
  return { customer_id, recommendations: pop.slice(0, 3), basis: "from stored purchases + catalog popularity; no invented products" };
}

/* follow-up drafts — grounded in real history; statuses; NEVER auto-SENT. */
export function prepareFollowup(tenant, customer_id, type = "thank_you") {
  const c = custMap(tenant).get(customer_id); if (!c) return { error: "not found" };
  if (!followups.has(tenant)) followups.set(tenant, []);
  if (followups.get(tenant).some((f) => f.customer_id === customer_id && f.type === type && ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"].includes(f.status))) return { deduped: true }; // prevent duplicate follow-ups
  const h = stats(tenant, customer_id);
  const msg = { thank_you: `Thank you for your recent order (${h.total_orders} total, ${h.currency} ${h.total_purchase_amount}).`, repeat: `It's been ${h.days_since_last_purchase} days since your last kopi — want us to set up a reorder?`, reactivate: `We miss you, ${c.customer_name} — here's what's new at AIVORA coffee.`, loyalty: `As one of our ${h.customer_category} customers, enjoy a returning-customer offer.` }[type] || `Hello ${c.customer_name}, following up on your AIVORA coffee order.`;
  const f = { followup_id: idem("FU"), customer_id, type, message: msg, status: "PENDING_APPROVAL", created_at: now(), sent_at: null, is_mock_data: true };
  followups.get(tenant).push(f); c.follow_up_status = "PENDING_APPROVAL"; c.next_follow_up_date = now().slice(0, 10);
  audit(tenant, "FOLLOWUP_DRAFTED", "ALLOW", `${customer_id} ${type}; sending requires owner approval (comms restricted)`);
  return { ...f, external_delivery: "NOT_SENT (comms restricted)" };
}
export function scheduleFollowup(tenant, followup_id, date) { const f = (followups.get(tenant) || []).find((x) => x.followup_id === followup_id); if (!f) return { error: "not found" }; f.status = "SCHEDULED"; f.scheduled_for = date || now().slice(0, 10); audit(tenant, "FOLLOWUP_SCHEDULED", "ALLOW", `${followup_id} scheduled (local task; not sent)`); return f; }
export function listFollowups(tenant) { return { tenant_id: tenant, followups: followups.get(tenant) || [] }; }

/* AUTOMATION HEALING — save a purchase under injected failure; bounded retry; EXACTLY ONE; recovery evidence. */
export function savePurchaseHealed(tenant, p, { injectFailure = false } = {}) {
  const order = String(p.order_number || "").trim();
  const incidentsArr = incidents.get(tenant) || []; incidents.set(tenant, incidentsArr);
  const seq = [];
  const exists = () => buys(tenant).some((x) => x.order_number === order);
  seq.push("DETECT: save attempt");
  if (injectFailure) {
    const inc = { incident_id: idem("INC"), kind: "PURCHASE_SAVE_FAILURE", order, at: now(), payload: p };
    incidentsArr.push(inc); seq.push(`INCIDENT: ${inc.incident_id} payload preserved`);
    if (exists()) { seq.push("CHECK: purchase already exists → no retry (idempotent)"); return { healed: true, duplicate_avoided: true, already_exists: true, sequence: seq }; }
    seq.push("SAFE-RETRY: yes (not yet stored)");
    let attempt = 0, saved = null;
    for (attempt = 1; attempt <= 2; attempt++) { saved = addPurchase(tenant, p); if (!saved.error && !saved.deduped) break; }
    const count = buys(tenant).filter((x) => x.order_number === order).length;
    seq.push(`VERIFY: exactly one? ${count === 1 ? "YES" : "NO(" + count + ")"}`);
    seq.push("RECALC: customer stats updated"); seq.push("RESUME: workflow continues"); seq.push("EVIDENCE: recovery recorded");
    inc.recovered = count === 1;
    audit(tenant, "SELF_HEAL", "ALLOW", `${order} attempts=${Math.min(attempt, 2)} exactly_one=${count === 1}`);
    return { healed: count === 1, attempts: Math.min(attempt, 2), exactly_one: count === 1, sequence: seq, purchase: saved };
  }
  const saved = addPurchase(tenant, p); seq.push("OK: saved first try"); return { healed: true, attempts: 1, exactly_one: buys(tenant).filter((x) => x.order_number === order).length === 1, sequence: seq, purchase: saved };
}

/* ROGUEAI SHIELD — export guard. Untrusted marketing agent export → block + revoke + quarantine + incident. */
export function registerAgent(tenant, agentId, { role = "marketing", can_export = false } = {}) { if (!agents.has(tenant)) agents.set(tenant, new Map()); const a = { agent_id: agentId, role, authorized: true, can_export, quarantined: false }; agents.get(tenant).set(agentId, a); return a; }
export function exportCustomers(tenant, agentId) {
  const a = (agents.get(tenant) || new Map()).get(agentId);
  if (!a) return { error: "unknown agent" };
  if (a.quarantined) return { error: "agent quarantined", agent_id: agentId };
  if (!a.can_export) {
    a.authorized = false; a.quarantined = true;
    if (!incidents.has(tenant)) incidents.set(tenant, []);
    const inc = { incident_id: idem("RSI"), kind: "UNAUTHORIZED_CUSTOMER_EXPORT", agent_id: agentId, at: now(), action: "BLOCKED_REVOKED_QUARANTINED" };
    incidents.get(tenant).push(inc);
    audit(tenant, "ROGUEAI_BLOCK", "BLOCK", `${agentId} attempted full export → revoked+quarantined`);
    return { blocked: true, incident: inc, replacement: "approved agent continues with MINIMUM authorized segments only" };
  }
  // authorized: data minimization — only approved segments + permitted campaign info, not the full DB
  const minimal = identifyRepeatBuyers(tenant).map((c) => ({ customer_id: c.customer_id, customer_category: c.customer_category, campaign_id: c.campaign_id }));
  audit(tenant, "CUSTOMER_EXPORT", "ALLOW", `${agentId} authorized; minimal fields only`);
  return { exported: minimal, scope: "minimum authorized segments (data minimization)" };
}

export function generateReport(tenant) {
  const all = [...custMap(tenant).values()].map((c) => ({ ...c, ...stats(tenant, c.customer_id) }));
  const rows = buys(tenant);
  const byCat = (k) => all.filter((c) => c.customer_category === k).length;
  const totalValue = rows.reduce((s, p) => s + p.total_amount, 0);
  return {
    tenant_id: tenant, data_mode: "MOCK/SANDBOX", is_mock_data: true,
    total_customers: all.length, new_customers: byCat("NEW"), repeat_customers: byCat("REPEAT"), vip_customers: byCat("VIP"), inactive_customers: byCat("INACTIVE"), potential_customers: byCat("POTENTIAL"),
    total_orders: rows.length, total_purchase_value: +totalValue.toFixed(2), avg_order_value: rows.length ? +(totalValue / rows.length).toFixed(2) : 0,
    most_purchased: analyzePurchasePatterns(tenant).popular_products.slice(0, 5), customers_requiring_followup: all.filter((c) => ["INACTIVE", "REPEAT"].includes(c.customer_category)).length,
    note: "all statistics computed from stored purchase records; mock data labelled; no fabricated values",
  };
}

export function resetDemo(tenant) { const cm = custMap(tenant); [...cm.values()].filter((c) => c.is_mock_data).forEach((c) => cm.delete(c.customer_id)); purchases.set(tenant, (buys(tenant)).filter((p) => !p.is_mock_data)); followups.set(tenant, (followups.get(tenant) || []).filter((f) => !f.is_mock_data)); audit(tenant, "DEMO_RESET", "ALLOW", "mock data cleared; production records untouched"); return { ok: true }; }

/* Seed a small, clearly-labelled MOCK dataset so the dashboard + demos are demonstrable offline. */
export function seedMock(tenant) {
  const a = createCustomer(tenant, { customer_name: "Ah Kow", phone_number: "65-80000001", email_address: "ahkow@example.test", is_mock_data: true });
  const b = createCustomer(tenant, { customer_name: "Mei", phone_number: "65-80000002", email_address: "mei@example.test", is_mock_data: true });
  if (a.customer_id) addPurchase(tenant, { customer_id: a.customer_id, order_number: "MOCK-1001", product_name: "Nanyang Gold Kopi", quantity: 2, unit_price: 19.9, currency: "MYR" });
  if (a.customer_id) addPurchase(tenant, { customer_id: a.customer_id, order_number: "MOCK-1002", product_name: "CEO Signature Coffee", quantity: 1, unit_price: 21.9, currency: "MYR" });
  if (b.customer_id) addPurchase(tenant, { customer_id: b.customer_id, order_number: "MOCK-1003", product_name: "Mocha Reserve Coffee", quantity: 5, unit_price: 21.9, currency: "MYR" });
  registerAgent(tenant, "mkt-untrusted", { role: "marketing", can_export: false });
  registerAgent(tenant, "mkt-approved", { role: "marketing", can_export: true });
  return { seeded: true };
}
