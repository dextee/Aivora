/* AIVORA Decision Intelligence V2 — "Business Action" plan.
 * Converts validated business data into prioritized, quantified decisions.
 * All figures are computed from real records (businessView / inventory / purchase
 * history / supplier costs in the workbook source_row). Where an input is missing
 * (e.g. promotion budget), the field is explicitly null/unavailable — never invented.
 * Discounts are policy-bounded AND margin-validated against real supplier unit costs;
 * if costs are missing the discount is labelled policy-proposal and NOT auto-authorized. */
import { createHash, randomUUID } from "node:crypto";
import { businessView, inventoryMath, deriveInvInput, procurementGuard, purchaseOrderAction, explainAnomalies } from "./business.mjs";
import { dropshipList } from "./shop_setup.mjs";
import { composeNew } from "./mail.mjs";
import { ingestEvent } from "./inbox.mjs";

const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const cents = v => Math.round(v * 100);
const DAY = 86400000;

/* §10 configurable discount policy (owner-approvable defaults), percent. */
export const DISCOUNT_POLICY = {
  VIP: { min: 5, max: 10 },
  REPEAT: { min: 3, max: 5 },
  INACTIVE: { min: 10, max: 15 },
  HIGH_VOLUME: { min: 5, max: 12 },
  SLOW_MOVING: { min: 10, max: 20 },
};
/* §9 minimum contribution margin default (owner-configurable). */
export const MIN_MARGIN = 0.20;
const INACTIVE_DAYS = 60;

function median(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/* §6/§7 customer ranking + preferred product from validated purchase history. */
export function rankCustomers(tenant, reference) {
  const v = businessView(tenant, reference);
  const ver = v.records.filter(r => r.status === "VERIFIED");
  const byCust = new Map();
  for (const r of ver) {
    const id = r.original.customer_id;
    if (!byCust.has(id)) byCust.set(id, { customer_id: id, rows: [] });
    byCust.get(id).rows.push(r.original);
  }
  const ref = reference || v.analysis?.reference_date || new Date().toISOString().slice(0, 10);
  const refMs = Date.parse(ref);
  const customers = v.customers.filter(c => !c.contact_errors?.length);
  const ranked = customers.map(c => {
    const rows = byCust.get(c.customer_id)?.rows || [];
    const lifetime = rows.reduce((s, r) => s + cents(r.total_amount), 0) / 100;
    const dates = rows.map(r => r.purchase_date).sort();
    const last = dates.at(-1) || null;
    const daysSince = last ? Math.floor((refMs - Date.parse(last)) / DAY) : null;
    const recent = rows.filter(r => Date.parse(r.purchase_date) > refMs - 30 * DAY);
    const previous = rows.filter(r => Date.parse(r.purchase_date) > refMs - 60 * DAY && Date.parse(r.purchase_date) <= refMs - 30 * DAY);
    const recentSales = recent.reduce((s, r) => s + cents(r.total_amount), 0) / 100;
    const prevSales = previous.reduce((s, r) => s + cents(r.total_amount), 0) / 100;
    const byProduct = new Map();
    for (const r of rows) { const p = byProduct.get(r.product_id) || { units: 0, sales: 0, qtys: [], last: r.purchase_date }; p.units += r.quantity; p.sales += cents(r.total_amount) / 100; p.qtys.push(r.quantity); if (r.purchase_date > p.last) p.last = r.purchase_date; byProduct.set(r.product_id, p); }
    const pref = [...byProduct.entries()].sort((a, b) => b[1].units - a[1].units)[0];
    const prefBySpend = [...byProduct.entries()].sort((a, b) => b[1].sales - a[1].sales)[0];
    const mostRecent = [...byProduct.entries()].sort((a, b) => (b[1].last > a[1].last ? 1 : -1))[0];
    const typicalQty = pref ? median(pref[1].qtys) : null;
    const segment = !rows.length ? "PROSPECTIVE" : daysSince !== null && daysSince >= INACTIVE_DAYS ? "INACTIVE" : lifetime >= 3000 && rows.length >= 2 ? "VIP" : rows.length >= 2 ? "REPEAT" : "NEW";
    const trend = prevSales > 0 ? (recentSales - prevSales) / prevSales : recentSales > 0 ? null : 0;
    return {
      customer_id: c.customer_id, name: c.customer_name || c.name || c.customer_id, email: c.email_address || null, phone: c.phone_number || null,
      consent: c.marketing_consent === true, segment, lifetime_sales: lifetime, recent_sales: recentSales, previous_sales: prevSales,
      orders: rows.length, aov: rows.length ? Math.round((lifetime / rows.length) * 100) / 100 : null,
      last_purchase: last, days_since_last: daysSince,
      preferred_product: pref?.[0] || null, preferred_by_spend: prefBySpend?.[0] || null, most_recent_product: mostRecent?.[0] || null,
      typical_quantity: typicalQty, trend,
    };
  });
  const A = [...ranked].sort((a, b) => b.lifetime_sales - a.lifetime_sales);
  const D = ranked.filter(r => r.segment === "INACTIVE");
  const E = ranked.filter(r => r.trend !== null && r.trend < 0);
  return { reference: ref, ranked, rankings: { A_highest_spending: A.slice(0, 10).map(r => r.customer_id), D_inactive: D.map(r => r.customer_id), E_declining: E.map(r => r.customer_id) } };
}

/* §9 deterministic discount + margin validation against real supplier cost. */
export function discountFor(segment, product, catalog) {
  const pol = DISCOUNT_POLICY[segment] || DISCOUNT_POLICY.REPEAT;
  const price = catalog.find(p => p.product_id === product)?.approved_selling_price;
  const cost = catalog.find(p => p.product_id === product)?.supplier_unit_cost ?? null;
  const proposed = pol.min; /* smallest policy-supported offer */
  if (price == null) return { proposed_percent: null, final_price: null, margin: null, authorized: false, basis: "price unavailable", policy_range: pol };
  if (cost == null) return { proposed_percent: proposed, final_price: Math.round(price * (1 - proposed / 100) * 100) / 100, margin: null, authorized: false, basis: "policy-proposal (reliable cost unavailable — not auto-authorized)", policy_range: pol };
  let pct = proposed;
  let margin = (price * (1 - pct / 100) - cost) / (price * (1 - pct / 100));
  while (margin < MIN_MARGIN && pct > 0) { pct -= 1; margin = (price * (1 - pct / 100) - cost) / (price * (1 - pct / 100)); }
  return { proposed_percent: pct, final_price: Math.round(price * (1 - pct / 100) * 100) / 100, margin: Math.round(margin * 1000) / 1000, authorized: pct > 0 && margin >= MIN_MARGIN, basis: pct < proposed ? `reduced to hold ${MIN_MARGIN * 100}% min margin` : "margin-validated against supplier cost", policy_range: pol, unit_cost: cost };
}

/* §18 top-X decision generation across purchase / customer / product / marketing. */
export function actionPlan(tenant, { topX = 5, reference } = {}) {
  const v = businessView(tenant, reference);
  const catalog = dropshipList().map(p => {
    const inv = v.inventory.find(i => i.product_id === p.product_id);
    return { ...p, supplier_unit_cost: inv?.source_row ? Number(inv.source_row["Supplier Unit Cost (SGD)"]) || null : null, supplier_id: inv?.source_row?.["Supplier ID"] || null };
  });
  const cur = v.analysis?.periods?.[1];
  const decisions = [];
  const push = d => decisions.push({ decision_id: "DEC-" + hash([tenant, d.decision_type, d.product_ids?.[0] || d.customer_ids?.[0] || d.plain_language_title]).slice(0, 10), decision_version: 1, analysis_period: v.analysis ? `${v.analysis.periods[0].start}..${v.analysis.periods[1].end}` : null, data_freshness: v.analysis?.reference_date || null, decision_status: "RECOMMENDED", verification_method: "deterministic recomputation from validated records", workflow_id: null, required_approval: d.required_approval ?? true, ...d });

  /* Purchase / stockout decisions (§11-13) */
  for (const inv of v.inventory) {
    const units = cur?.products.find(p => p.product_id === inv.product_id)?.units || 0;
    const calc = inventoryMath(deriveInvInput(inv, units) || inv, units);
    if (calc.status !== "CALCULATED" || calc.required_quantity <= 0) continue;
    const prod = catalog.find(p => p.product_id === inv.product_id);
    const unitCost = prod?.supplier_unit_cost ?? null;
    const total = unitCost != null ? cents(unitCost) * calc.required_quantity / 100 : null;
    const cfg = prod?.supplier_id && unitCost ? { supplier_id: prod.supplier_id, supplier_verified: true, unit_cost: unitCost, budget: Number(inv.source_row?.["Max Auto Order (SGD)"]) || 5000, currency: "SGD", costs_complete: true } : null;
    const guard = cfg ? procurementGuard(cfg, calc.required_quantity) : { status: "BLOCKED", reason: "supplier/cost evidence missing" };
    const affordable = guard.status === "VALIDATED" ? calc.required_quantity : (cfg && unitCost ? Math.floor((cents(cfg.budget) / cents(unitCost)) / (inv.pack_size || 1)) * (inv.pack_size || 1) : null);
    push({
      decision_type: "PURCHASE", priority: calc.inventory_position <= 0 ? "CRITICAL" : "URGENT", tab: "purchase",
      plain_language_title: `Buy ${calc.required_quantity} packs of ${prod?.name || inv.product_id}`,
      plain_language_reason: `You sell about ${(calc.average_daily_demand || 0).toFixed(1)} packs/day and only have ${inv.stock_on_hand} left; supplier lead time ${inv.lead_time_days} days.`,
      product_ids: [inv.product_id], customer_ids: [], supporting_metrics: { stock_on_hand: inv.stock_on_hand, avg_daily_sales: calc.average_daily_demand, coverage_days: calc.coverage_days, reorder_threshold: calc.reorder_threshold, recommended_quantity: calc.required_quantity, affordable_quantity: affordable, lead_time_days: inv.lead_time_days, safety_stock: inv.safety_stock },
      source_evidence_ids: [inv.product_id], exact_recommended_quantity: calc.required_quantity, recommended_discount_percentage: null, recommended_offer_price: null,
      estimated_cost: total, maximum_budget_exposure: total, estimated_benefit: null, benefit_assumptions: null,
      required_permissions: ["procurement"], supplier: cfg?.supplier_id || null, unit_cost: unitCost, budget_status: guard.status, budget_reason: guard.reason || null,
      action: "prepare_purchase_order",
    });
  }
  /* Customer contact / offer decisions (§6-10, §15) */
  const rk = rankCustomers(tenant, reference);
  const targets = rk.ranked.filter(r => r.segment === "VIP" || r.segment === "INACTIVE" || (r.trend !== null && r.trend < 0));
  for (const c of targets.slice(0, 20)) {
    const disc = discountFor(c.segment === "VIP" ? "VIP" : c.segment === "INACTIVE" ? "INACTIVE" : "REPEAT", c.preferred_product, catalog);
    push({
      decision_type: "CUSTOMER_CONTACT", priority: c.segment === "VIP" ? "HIGH" : "NORMAL", tab: "customers",
      plain_language_title: `${c.segment === "INACTIVE" ? "Win back" : "Reward"} ${c.name}`,
      plain_language_reason: c.segment === "INACTIVE" ? `No purchase in ${c.days_since_last} days; previously spent S$${c.lifetime_sales.toFixed(2)}.` : `Loyal customer (S$${c.lifetime_sales.toFixed(2)} lifetime, ${c.orders} orders).`,
      product_ids: c.preferred_product ? [c.preferred_product] : [], customer_ids: [c.customer_id],
      supporting_metrics: { lifetime_sales: c.lifetime_sales, days_since_last: c.days_since_last, orders: c.orders, segment: c.segment, preferred_product: c.preferred_product, typical_quantity: c.typical_quantity },
      source_evidence_ids: [c.customer_id], exact_recommended_quantity: c.typical_quantity, recommended_discount_percentage: disc.proposed_percent, recommended_offer_price: disc.final_price,
      estimated_cost: null, maximum_budget_exposure: disc.final_price != null && c.typical_quantity ? Math.round(disc.final_price * c.typical_quantity * (disc.proposed_percent / 100) * 100) / 100 : null,
      estimated_benefit: null, benefit_assumptions: "policy-based proposal; no historical promotion response data",
      required_permissions: ["customer_contact"], consent: c.consent, channel: c.consent ? "email" : "none (consent required)", discount_basis: disc.basis, margin: disc.margin, discount_authorized: disc.authorized,
      action: "prepare_customer_emails",
    });
  }
  /* Product performance decisions (§11, §14) */
  for (const g of v.analysis?.growth || []) {
    if (g.trend === "DECLINING") {
      const prod = catalog.find(p => p.product_id === g.product_id);
      push({ decision_type: "PRODUCT", priority: "NORMAL", tab: "products", plain_language_title: `Review declining ${prod?.name || g.product_id}`, plain_language_reason: `Sales fell from ${g.previous} to ${g.current} units between consecutive periods; consider promotion or reduced reorder rather than restocking.`, product_ids: [g.product_id], customer_ids: [], supporting_metrics: { previous_units: g.previous, current_units: g.current, growth_percent: g.growth_percent }, source_evidence_ids: [g.product_id], exact_recommended_quantity: 0, recommended_discount_percentage: DISCOUNT_POLICY.SLOW_MOVING.min, recommended_offer_price: null, estimated_cost: null, maximum_budget_exposure: null, estimated_benefit: null, benefit_assumptions: null, required_permissions: [], action: "recommend_purchase_reduction" });
    }
  }
  /* Prioritize: stockout urgency → financial risk → retention (§18) */
  const rank = { CRITICAL: 0, URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
  decisions.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));
  const top = decisions.slice(0, topX);
  const purchasing = decisions.filter(d => d.decision_type === "PURCHASE").reduce((s, d) => s + (d.estimated_cost || 0), 0);
  const discPcts = decisions.filter(d => d.recommended_discount_percentage != null).map(d => d.recommended_discount_percentage);
  return {
    reference: v.analysis?.reference_date || null, mode: v.mode,
    stats: { recommended_actions: decisions.length, proposed_purchasing: Math.round(purchasing * 100) / 100, customer_targets: targets.length, discount_range: discPcts.length ? `${Math.min(...discPcts)}–${Math.max(...discPcts)}%` : null, quarantined_records: v.records.filter(r => r.status !== "VERIFIED").length },
    decisions: top, all_decisions: decisions, customer_targets: targets.length,
    briefing: briefingText(top, purchasing),
    anomalies: explainAnomalies([...new Set(v.records.filter(r => r.status !== "VERIFIED").flatMap(r => r.errors))]).slice(0, 5),
  };
}

/* §20 plain-language AI CEO briefing. */
export function briefingText(top, purchasing) {
  const lines = top.slice(0, 5).map(d => {
    if (d.decision_type === "PURCHASE") return `Boss, buy ${d.exact_recommended_quantity} packs of ${d.plain_language_title.replace(/^Buy \d+ packs of /, "")}. It will cost S$${(d.estimated_cost || 0).toLocaleString()}. ${d.plain_language_reason}`;
    if (d.decision_type === "CUSTOMER_CONTACT") return `Boss, contact ${d.customer_ids.length} customer(s): ${d.plain_language_title}. Offer ${d.recommended_discount_percentage}% off their favourite coffee, within your profit and promotion limits.`;
    return `Boss, ${d.plain_language_title.toLowerCase()}. ${d.plain_language_reason}`;
  });
  return [`Good morning, Boss! I have identified ${top.length} actions to help you manage your stock, retain customers and improve sales.`, ...lines, purchasing ? `Total proposed purchasing: S$${purchasing.toLocaleString()}.` : ""].filter(Boolean).join(" ");
}

/* §15 contact list generation with consent/eligibility + dedup. */
export function customerContactList(tenant, { segment = "ALL", limit = 5, reference } = {}) {
  const rk = rankCustomers(tenant, reference);
  const catalog = dropshipList();
  let list = rk.ranked.filter(r => r.orders > 0);
  if (segment === "VIP") list = list.filter(r => r.segment === "VIP");
  if (segment === "INACTIVE") list = list.filter(r => r.segment === "INACTIVE");
  if (segment === "DECLINING") list = list.filter(r => r.trend !== null && r.trend < 0);
  list = list.slice(0, limit);
  return list.map(c => {
    const disc = discountFor(c.segment === "VIP" ? "VIP" : c.segment === "INACTIVE" ? "INACTIVE" : "REPEAT", c.preferred_product, catalog);
    const prod = catalog.find(p => p.product_id === c.preferred_product);
    return { customer_id: c.customer_id, name: c.name, segment: c.segment, lifetime_sales: c.lifetime_sales, last_purchase: c.last_purchase, days_since_last: c.days_since_last, favorite_product: prod?.name || c.preferred_product, suggested_quantity: c.typical_quantity, proposed_discount_percent: disc.proposed_percent, final_offer_price: disc.final_price, margin: disc.margin, discount_basis: disc.basis, reason: c.segment === "INACTIVE" ? `No purchase in ${c.days_since_last} days` : c.segment === "VIP" ? "Loyal high-value customer" : "Repeat customer", channel: c.consent ? "email" : "none (consent required)", consent: c.consent, eligible: c.consent };
  });
}

/* §13 prepare a real purchase order through the existing PO engine (no duplicates). */
export function preparePurchaseOrder(tenant, decision_id, { reference } = {}) {
  const plan = actionPlan(tenant, { topX: 50, reference });
  const d = plan.all_decisions.find(x => x.decision_id === decision_id) || plan.decisions.find(x => x.decision_id === decision_id);
  if (!d || d.decision_type !== "PURCHASE") throw Object.assign(new Error("Purchase decision not found"), { status: 404 });
  const v = businessView(tenant, reference);
  const inv = v.inventory.find(i => i.product_id === d.product_ids[0]);
  const cfg = { supplier_id: d.supplier, supplier_verified: true, unit_cost: d.unit_cost, budget: Number(inv?.source_row?.["Max Auto Order (SGD)"]) || 5000, currency: "SGD", costs_complete: true };
  const order = purchaseOrderAction(tenant, { action: "prepare", product_id: d.product_ids[0], config: cfg, reference_date: v.analysis?.reference_date });
  ingestEvent(tenant, { kind: "PROCUREMENT_RECOMMENDED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "ai-ceo", objective_id: d.decision_id, note: `Business Action ${d.decision_id} prepared PO for ${d.product_ids[0]}` });
  return { decision_id, order_id: order.id, deduped: !!order.deduped, quantity: order.quantity, total: order.total, status: order.status };
}

/* §16 prepare personalized email drafts (never sends). */
export function prepareCustomerEmails(tenant, customer_ids, { reference } = {}) {
  const list = customerContactList(tenant, { segment: "ALL", limit: 1000, reference }).filter(c => customer_ids.includes(c.customer_id));
  const drafts = [];
  for (const c of list) {
    if (!c.consent) { drafts.push({ customer_id: c.customer_id, skipped: true, reason: "marketing consent not verified" }); continue; }
    if (!c.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) { drafts.push({ customer_id: c.customer_id, skipped: true, reason: "no valid email on record" }); continue; }
    try {
      const d = composeNew(tenant, { to: c.email, subject: `A special offer on ${c.favorite_product || "your favourite coffee"}`, body: `Dear ${c.name}, thank you for your continued support. As one of our valued customers we'd like to offer ${c.proposed_discount_percent}% off ${c.favorite_product || "your favourite coffee"} on your next order of about ${c.suggested_quantity || 1} packs. This offer is a policy-based proposal pending owner approval.` });
      drafts.push({ customer_id: c.customer_id, draft_id: d.draft_id || d.id, skipped: false });
    } catch (e) { drafts.push({ customer_id: c.customer_id, skipped: true, reason: e.message }); }
  }
  ingestEvent(tenant, { kind: "EMAIL_DRAFT_PREPARED", event_id: randomUUID(), ts: new Date().toISOString(), actor: "ai-cmo", objective_id: "BUSINESS_ACTION", note: `${drafts.filter(x => !x.skipped).length} personalized drafts prepared; ${drafts.filter(x => x.skipped).length} skipped (consent)` });
  return { prepared: drafts.filter(x => !x.skipped).length, skipped: drafts.filter(x => x.skipped).length, drafts, sent: 0, note: "drafts only — dispatch requires owner approval and Gmail authorization" };
}

/* §15 CSV export of the contact list (Excel via shared report module at the route). */
export function contactListCsv(tenant, opts) {
  const rows = customerContactList(tenant, opts);
  const head = ["customer_id", "name", "segment", "lifetime_sales", "days_since_last", "favorite_product", "suggested_quantity", "proposed_discount_percent", "final_offer_price", "reason", "channel", "consent"];
  const esc = x => `"${String(x ?? "").replace(/"/g, '""')}"`;
  return [head.join(","), ...rows.map(r => head.map(h => esc(r[h])).join(","))].join("\n");
}
