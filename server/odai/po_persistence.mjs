/* Durable purchase-order persistence (migration 010) for online/Supabase mode.
 * Write-through: every local PO mutation is mirrored to odai_purchase_order /
 * odai_po_status_history / odai_po_receipt / odai_inventory_movement using the
 * request-scoped (signed-in) client, so Postgres RLS enforces workspace + role.
 * Fail-closed: if online is enabled and persistence fails, the error propagates
 * (no silent memory-only success). Offline mode is a complete no-op. */
import { isOffline, supabaseConfigured, scopedClient, requestCtx } from "./db.mjs";

export const onlineEnabled = () => !isOffline() && supabaseConfigured() && !!requestCtx.getStore()?.token;

export async function persistOrderOnline(tenant, order) {
  if (!onlineEnabled()) return { persisted: false, reason: "offline or unauthenticated" };
  const client = scopedClient();
  const { error } = await client.from("odai_purchase_order").upsert({
    tenant_id: tenant, po_id: order.id, sku: order.product_id, supplier_id: order.config?.supplier_id,
    quantity: order.quantity, received_units: order.received_units ?? 0, outstanding_units: order.outstanding_units ?? order.quantity,
    unit_cost: order.config?.unit_cost ?? 0, total: order.total ?? 0, currency: order.config?.currency || "SGD",
    status: order.status, version: order.version ?? 1, action_hash: order.action_hash ?? "", config: order.config || {},
    evidence: order.evidence || {}, is_sandbox: order.is_sandbox !== false, sent_to_supplier: !!order.sent_to_supplier,
    created_at: order.created_at || new Date().toISOString(), approved_at: order.approved_at || null, cancelled_at: order.cancelled_at || null,
  });
  if (error) throw Object.assign(new Error("Durable PO persistence failed: " + error.message), { status: 503, code: "PO_PERSIST_FAILED" });
  /* append-only history: insert any transitions not yet recorded */
  const hist = (order.status_history || []).map(h => ({ tenant_id: tenant, po_id: order.id, status: h.status, note: h.note || null, ts: h.at || new Date().toISOString() }));
  if (hist.length) {
    const { error: herr } = await client.from("odai_po_status_history").insert(hist);
    /* duplicate seq/status rows are acceptable to ignore; genuine failures are not */
    if (herr && !/duplicate key/i.test(herr.message)) throw Object.assign(new Error("Durable PO history persistence failed: " + herr.message), { status: 503, code: "PO_PERSIST_FAILED" });
  }
  return { persisted: true };
}

export async function persistReceiptOnline(tenant, order, receipt, movement) {
  if (!onlineEnabled()) return { persisted: false };
  const client = scopedClient();
  const { error } = await client.from("odai_po_receipt").insert({ tenant_id: tenant, po_id: order.id, receipt_key: receipt.receipt_key, units: receipt.units, ts: receipt.at || new Date().toISOString() });
  if (error && !/duplicate key/i.test(error.message)) throw Object.assign(new Error("Durable receipt persistence failed: " + error.message), { status: 503, code: "PO_PERSIST_FAILED" });
  if (movement) {
    const { error: merr } = await client.from("odai_inventory_movement").insert({ tenant_id: tenant, movement_id: movement.id, po_id: order.id, sku: movement.product_id, delta: movement.delta, reason: movement.reason, receipt_key: movement.receipt_key, ts: movement.ts });
    if (merr && !/duplicate key/i.test(merr.message)) throw Object.assign(new Error("Durable movement persistence failed: " + merr.message), { status: 503, code: "PO_PERSIST_FAILED" });
  }
  return { persisted: true };
}

export async function loadOrdersOnline(tenant) {
  if (!onlineEnabled()) return null;
  const client = scopedClient();
  const { data, error } = await client.from("odai_purchase_order").select("*").eq("tenant_id", tenant).order("created_at", { ascending: false });
  if (error) throw Object.assign(new Error("Durable PO read failed: " + error.message), { status: 503, code: "PO_READ_FAILED" });
  return data || [];
}
