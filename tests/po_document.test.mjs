import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
process.env.AIVORA_MEMORY_MODE = "1";
const m = await import("../server/odai/po_document.mjs");
const biz = await import("../server/odai/business.mjs");
const shop = await import("../server/odai/shop_setup.mjs");

const XLSX = "D:\\AIVORA\\MAIN-FIX\\DB\\AIVORA_Coffee_SGD_Anomaly_and_Reorder (1).xlsx";

test("PD-01 native XLSX decode reads the approved workbook sheets and maps records", async () => {
  const buf = readFileSync(XLSX);
  const d = await m.decodeWorkbookXlsx(buf, shop.dropshipList());
  assert.ok(d.sheets.includes("Customers") && d.sheets.includes("Purchase History") && d.sheets.includes("Inventory"), "sheets found");
  assert.equal(d.customers.length, 1000, "1000 customers decoded");
  assert.equal(d.purchases.length, 1000, "1000 purchases decoded");
  assert.equal(d.inventory.length, 5, "5 inventory rows decoded");
  const inv = d.inventory.find(i => i.product_id === "COF-CEO-001");
  assert.equal(inv.stock_on_hand, 450, "stock decoded from workbook");
  assert.equal(Number(inv.source_row["Supplier Unit Cost (SGD)"]), 10, "supplier unit cost decoded");
  const p = d.purchases[0];
  assert.ok(p.order_number && p.customer_id && p.product_id && p.purchase_date && p.quantity > 0, "purchase mapped with product_id resolved");
  assert.equal(p.currency, "SGD");
});

test("PD-02 purchase-order PDF generated from the authoritative order record", () => {
  const T = "demo-uncle-coffee-wellness";
  biz.labClearOrders(T);
  const v0 = biz.businessView(T);
  const inv = v0.inventory.find(i => i.source_row?.["Supplier ID"]);
  const cfg = { supplier_id: inv.source_row["Supplier ID"], supplier_verified: true, unit_cost: Number(inv.source_row["Supplier Unit Cost (SGD)"]), budget: 100000, currency: "SGD", costs_complete: true };
  const fix = biz.labSetStock(T, inv.product_id, 0);
  let order;
  try {
    order = biz.purchaseOrderAction(T, { action: "prepare", product_id: inv.product_id, config: cfg, reference_date: v0.analysis.reference_date });
  } finally { biz.labSetStock(T, inv.product_id, fix.previous); }
  const pdf = m.purchaseOrderPdf(order, shop.dropshipList());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", "valid PDF header");
  assert.ok(pdf.length > 800, "non-trivial PDF");
  const rec = m.storeDocument(T, `PO-${order.id.slice(0, 8)}.pdf`, pdf, { order_id: order.id });
  assert.ok(rec.id.startsWith("DOC-"), "document stored");
  const back = m.getDocument(rec.id);
  assert.equal(back.buf.length, pdf.length, "document retrievable byte-identical");
  assert.ok(m.listDocuments(T).some(d => d.id === rec.id), "listed in My Documents");
});

test("PD-03 text PDF paginator handles multi-page content deterministically", () => {
  const lines = Array.from({ length: 120 }, (_, i) => "line " + i);
  const pdf = m.textPdf("MULTI", lines);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const pages = (pdf.toString("binary").match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(pages >= 3, "paginated into multiple pages, got " + pages);
});
