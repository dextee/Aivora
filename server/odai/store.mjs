/* odai/store.mjs — tenant-scoped demo store.
 * In-memory per FC instance for staging demo; Supabase attachment is WO-90-DB-003
 * (entities per Database spec §3). NO production data anywhere; multi-tenant
 * isolation enforced by explicit tenantId on every accessor.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ingestEvent } from "./inbox.mjs";
import { isOffline } from "./db.mjs";
import { fileURLToPath } from "node:url";

const load = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const catalog = load("../../odai/data/catalog_fnyglobal_seeded.json");
export const COMPANY = load("../../odai/config/company_profile.json");
const tenantCfg = load("../../odai/config/tenant_business.json");

const tenants = new Map();

export function ensureTenant(id) {
  if (!tenants.has(id)) {
    tenants.set(id, {
      id,
      products: catalog.products.map((p) => ({ ...p, tenant_id: id, review_state: "QUARANTINED" })),
      source_receipt: { source: catalog.source, captured: "2026-11-19", mode: catalog.import_mode, rights_note: catalog.rights_note },
      campaign: null, spend_approval: null, orders: [], ledger: [], trace: [], receipts: [], incidents: [],
      task_ids: [],
    });
  }
  return tenants.get(id);
}
export const DEMO_TENANT = tenantCfg.tenant_id;          // demo-uncle-coffee-wellness
export const OTHER_TENANT = "demo-other-tenant-42";      // used by isolation tests only

export function get(id) {
  if (!id) throw new Error("explicit tenant id required (import_rules.require_explicit_tenant_id)");
  return ensureTenant(id);
}

export function logEvent(t, e) {
  const event = { ts: new Date().toISOString(), ...e, event_id: e.event_id || randomUUID() };
  t.trace.push(event);
  if (isOffline()) {
    try { ingestEvent(t.id, event); }
    catch { t.inbox_persistence_failed = true; }
  }
  if (t.trace.length > 400) t.trace.shift();
  return t.trace[t.trace.length - 1];
}

/* finance rule (DB spec §4): profits require VERIFIED costs, else UNKNOWN — never estimated */
export function profitSnapshot(t) {
  const actualSales = t.orders.filter((o) => o.kind === "ACTUAL").reduce((s, o) => s + (o.amount || 0), 0);
  const testSales = t.orders.filter((o) => o.kind === "TEST_SIMULATED").reduce((s, o) => s + (o.amount || 0), 0);
  const verifiedCogs = t.orders.filter((o) => o.supplier_cost_verified).reduce((s, o) => s + (o.supplier_cost || 0), 0);
  return {
    currency_policy: "per-currency separation; MYR primary (tenant_business.currency_reporting)",
    actual: { net_sales: actualSales, gross_profit: actualSales ? "UNKNOWN (no verified COGS)" : 0, note: actualSales ? "cannot deduct unverified product cost" : "no actual orders" },
    test_simulated: { gross_merchandise_value: testSales, gross_profit: testSales ? "UNKNOWN — supplier_cost null for ALL FNYGlobal items" : 0, margin_basis: "NONE; price_type=PUBLIC_LISTED_NOT_WHOLESALE" },
    fulfillment: "handoff PREPARED only — supplier terms not agreed (fulfillment_mode UNVERIFIED_PENDING_AGREEMENT); no automated fulfillment asserted",
    rule: "Database spec §4: unknown costs => profit UNKNOWN, never estimated actual",
  };
}
