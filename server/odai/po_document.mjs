/* AIVORA — native XLSX workbook decoding + purchase-order PDF/document store.
 * Resolves two documented PO blockers with real implementations:
 *  - native XLSX decode (exceljs) so supplier costs/budget/inventory come from the
 *    approved workbook itself, not a hand-mapped JSON payload;
 *  - purchase-order PDF generation stored in the local document store (My Documents),
 *    served for download. No external service, no fabricated content. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const docDir = fileURLToPath(new URL("../../odai/data/documents/", import.meta.url));
const hashBuf = b => createHash("sha256").update(b).digest("hex");
const day = v => { const d = v instanceof Date ? v : new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(v || "").slice(0, 10); };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/* Decode the approved workbook natively into the mapped import shape. */
export async function decodeWorkbookXlsx(buffer, catalog) {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.default.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = n => wb.getWorksheet(n);
  const rowsOf = ws => { if (!ws) return []; const out = []; ws.eachRow((row, rn) => { if (rn === 1) return; const o = {}; ws.getRow(1).eachCell((c, ci) => { o[String(c.value).trim()] = row.getCell(ci).value; }); out.push(o); }); return out; };
  const nameToId = new Map((catalog || []).map(p => [String(p.name).toLowerCase(), p.product_id]));
  const customers = rowsOf(sheet("Customers")).map(r => ({
    customer_id: String(r["Customer ID"] || "").trim(), customer_name: String(r["Name"] || "").trim(), name: String(r["Name"] || "").trim(),
    address: String(r["Address"] || "").trim(), phone_number: String(r["Phone"] || "").trim(), email_address: String(r["Email"] || "").trim(),
    marketing_consent: String(r["Consent"] || "").toLowerCase() === "yes", source_row: r,
  })).filter(c => c.customer_id);
  const purchases = rowsOf(sheet("Purchase History")).map(r => {
    const qty = num(r["Qty"]); const total = num(r["Total"]);
    const product_id = nameToId.get(String(r["Product"] || "").toLowerCase()) || null;
    return { order_number: String(r["Order ID"] || "").trim(), customer_id: String(r["Customer ID"] || "").trim(), product_id, product_name: String(r["Product"] || "").trim(), purchase_date: day(r["Date"]), quantity: qty, total_amount: total, unit_price: qty ? Math.round((total / qty) * 100) / 100 : null, currency: "SGD", source_row: r };
  }).filter(p => p.order_number);
  const inventory = rowsOf(sheet("Inventory")).map(r => ({
    product_id: nameToId.get(String(r["Product"] || "").toLowerCase()) || null,
    stock_on_hand: num(r["Stock On Hand"]) ?? 0, committed_stock: num(r["Reserved Units"]) ?? 0, confirmed_incoming: num(r["Incoming Units"]) ?? 0,
    lead_time_days: num(r["Lead Time (Days)"]) ?? 0, safety_stock: num(r["Safety Stock"]) ?? 0, pack_size: num(r["Pack Size"]) || 1,
    target_cover_days: num(r["Target Cover (Days)"]) ?? 30, source_row: r,
  })).filter(i => i.product_id);
  return { customers, purchases, inventory, sheets: wb.worksheets.map(w => w.name) };
}

/* Minimal deterministic text PDF (no external deps). */
function textPdf(title, lines) {
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const perPage = 46; const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);
  let objs = []; const pageIds = []; const contentIds = [];
  const nPages = pages.length;
  // object layout: 1 catalog, 2 pages, 3 font, then per page: page obj + content obj
  for (let p = 0; p < nPages; p++) { pageIds.push(4 + p * 2); contentIds.push(5 + p * 2); }
  const kids = pageIds.map(id => `${id} 0 R`).join(" ");
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  pages.forEach((pl, pi) => {
    let stream = "BT /F1 10 Tf 50 780 Td 14 TL\n";
    stream += `(${esc(pi === 0 ? title : title + " (cont.)")}) Tj T*\n`;
    stream += "() Tj T*\n";
    for (const ln of pl) stream += `(${esc(ln.slice(0, 110))}) Tj T*\n`;
    stream += "ET";
    objs[pageIds[pi]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[pi]} 0 R >>`;
    objs[contentIds[pi]] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "binary");
}

/* §PO-008 / §22: generate the purchase-order PDF from the authoritative order record. */
export function purchaseOrderPdf(order, catalog) {
  const prod = (catalog || []).find(p => p.product_id === order.product_id) || {};
  const lines = [
    `Purchase Order ${order.id}`,
    `Status: ${order.status}   Version: v${order.version}   Sandbox: ${order.is_sandbox ? "yes" : "no"}`,
    `Created: ${order.created_at || ""}   Approved: ${order.approved_at || "not approved"}`,
    "",
    `Supplier: ${order.config?.supplier_id || "n/a"}   Supplier verified: ${order.config?.supplier_verified === true ? "yes" : "no"}`,
    `Product: ${prod.name || order.product_id} (${order.product_id})`,
    `Quantity: ${order.quantity} units   Pack size: ${order.evidence?.pack_size ?? order.config?.pack_size ?? "n/a"}`,
    `Unit cost: SGD ${(order.config?.unit_cost ?? 0).toFixed(2)}   Total: SGD ${(order.total ?? 0).toFixed(2)}`,
    `Currency: ${order.config?.currency || "SGD"}`,
    "",
    "Inventory evidence at preparation:",
    `  stock_on_hand=${order.evidence?.stock_on_hand}  confirmed_incoming=${order.evidence?.confirmed_incoming}  committed=${order.evidence?.committed_stock}`,
    `  lead_time_days=${order.evidence?.lead_time_days}  safety_stock=${order.evidence?.safety_stock}  target=${order.evidence?.target_inventory}`,
    `  average_daily_demand=${order.evidence?.calculation?.average_daily_demand}  reorder_threshold=${order.evidence?.calculation?.reorder_threshold}`,
    `  required_quantity=${order.evidence?.calculation?.required_quantity}`,
    "",
    "Lifecycle:",
    ...(order.status_history || []).map(h => `  ${h.at}  ${h.status}  ${h.note || ""}`),
    "",
    "Authorization: owner approval bound to action hash " + (order.action_hash || "n/a"),
    "External supplier submission: NOT performed (sandbox). Publication/spend locks preserved.",
  ];
  return textPdf("AIVORA PURCHASE ORDER", lines);
}

export function storeDocument(tenant, name, buf, meta = {}) {
  mkdirSync(docDir, { recursive: true });
  const id = "DOC-" + randomUUID().slice(0, 12);
  const rec = { id, tenant, name, sha256: hashBuf(buf), bytes: buf.length, created_at: new Date().toISOString(), meta, file: id + ".bin" };
  writeFileSync(docDir + rec.file, buf, { mode: 0o600 });
  const idx = docDir + "index.json";
  const list = existsSync(idx) ? JSON.parse(readFileSync(idx, "utf8")) : [];
  list.push(rec); writeFileSync(idx, JSON.stringify(list, null, 2), { mode: 0o600 });
  return rec;
}
export function listDocuments(tenant) {
  const idx = docDir + "index.json";
  if (!existsSync(idx)) return [];
  return JSON.parse(readFileSync(idx, "utf8")).filter(d => d.tenant === tenant);
}
export function getDocument(id) {
  const idx = docDir + "index.json";
  if (!existsSync(idx)) return null;
  const rec = JSON.parse(readFileSync(idx, "utf8")).find(d => d.id === id);
  if (!rec || !existsSync(docDir + rec.file)) return null;
  return { rec, buf: readFileSync(docDir + rec.file) };
}
export { textPdf };
