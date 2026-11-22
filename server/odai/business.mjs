import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isOffline } from './db.mjs';
import { searchCustomers, getPurchaseHistory } from './customers.mjs';
import { dropshipList } from './shop_setup.mjs';
import { DEMO_TENANT, get, logEvent } from './store.mjs';

const root = fileURLToPath(new URL('../../odai/data/business/', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const number = v => typeof v === 'number' && Number.isFinite(v);
const money = v => number(v) && v >= 0 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-7;
const cents = v => Math.round(v * 100);
/* Plain-language reasons explaining WHY a record/contact is quarantined or anomalous.
 * Additive: validation logic is unchanged; these only explain the existing error codes. */
export const ANOMALY_REASONS = {
  ORDER_ID_REQUIRED: 'Missing order number — the transaction cannot be uniquely identified or deduplicated.',
  DUPLICATE_ORDER_ID: 'Duplicate order number — the same order ID appears more than once, risking double-counted revenue.',
  DUPLICATE_PAYLOAD: 'Duplicate transaction — an identical customer/product/date/quantity/price/total row already exists (possible re-import or replay).',
  UNKNOWN_CUSTOMER: 'Unknown customer — the customer_id does not match any single verified contact record.',
  INVALID_DATE: 'Invalid purchase date — not a real calendar date in YYYY-MM-DD form.',
  INVALID_QUANTITY: 'Invalid quantity — must be a positive whole number of units.',
  UNKNOWN_PRODUCT: 'Unknown product — the product_id is not in the approved master catalog.',
  CURRENCY_MISMATCH: 'Currency mismatch — the row or product is not priced in SGD, the approved currency.',
  INVALID_MONEY: 'Invalid money value — unit price or total is not a valid non-negative amount with cent precision.',
  ARITHMETIC_DISCREPANCY: 'Arithmetic discrepancy — total does not equal unit price × quantity, so the stated amount cannot be trusted.',
  UNAUTHORIZED_PRICE: 'Unauthorized price — the unit price differs from the approved catalog selling price (possible price manipulation).',
  INVALID_EMAIL: 'Invalid email format — the address is not a valid email, so contact or reply cannot be verified.',
  INVALID_PHONE: 'Invalid phone format — the number is not a valid dialable format, so WhatsApp/SMS cannot be verified.',
  CONSENT_UNVERIFIED: 'Consent unverified — marketing consent is not an explicit yes/no, so outreach is not authorized.',
  DUPLICATE_CUSTOMER_ID: 'Duplicate customer ID — the same customer_id appears more than once, risking a merged or duplicated identity.',
};
export const explainAnomalies = codes => (codes || []).map(c => ({ code: c, reason: ANOMALY_REASONS[c] || c }));
export function businessScope(tenant) {
  if (!isOffline()) throw Object.assign(new Error('Online business access BLOCKED: validated user membership and durable schema integration required; no memory fallback'), { status: 503 });
  if (tenant !== DEMO_TENANT) throw Object.assign(new Error('Offline owner tenant denied'), { status: 403 });
}
function load(tenant) {
  businessScope(tenant);
  try { return JSON.parse(readFileSync(root + hash(tenant) + '.json', 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { batches: [], orders: [], events: [] }; throw e; }
}
function save(tenant, state) {
  mkdirSync(root, { recursive: true });
  const dest = root + hash(tenant) + '.json', tmp = dest + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, dest);
}
export function validateRows(rows, customers, catalog, prior = []) {
  const ids = new Set(customers.filter(c => c.customer_id && customers.filter(x => x.customer_id === c.customer_id).length === 1).map(c => c.customer_id));
  const all = [...prior, ...rows];
  return rows.map((raw, i) => {
    const errors = [], warnings = [];
    const product = catalog.find(p => p.product_id === raw.product_id);
    if (!raw.order_number) errors.push('ORDER_ID_REQUIRED');
    if (all.filter(p => p.order_number === raw.order_number).length > 1) errors.push('DUPLICATE_ORDER_ID');
    const payload = p => hash([p.customer_id,p.product_id,p.purchase_date,p.quantity,p.unit_price,p.total_amount,p.currency]);
    if (all.filter(p => payload(p) === payload(raw)).length > 1) errors.push('DUPLICATE_PAYLOAD');
    if (!ids.has(raw.customer_id)) errors.push('UNKNOWN_CUSTOMER');
    if (!date(raw.purchase_date)) errors.push('INVALID_DATE');
    if (!Number.isSafeInteger(raw.quantity) || raw.quantity <= 0) errors.push('INVALID_QUANTITY');
    if (!product) errors.push('UNKNOWN_PRODUCT');
    if (raw.currency !== 'SGD' || (product && product.currency !== 'SGD')) errors.push('CURRENCY_MISMATCH');
    if (!money(raw.unit_price) || !money(raw.total_amount)) errors.push('INVALID_MONEY');
    else {
      if (!Number.isSafeInteger(cents(raw.unit_price) * raw.quantity) || cents(raw.total_amount) !== cents(raw.unit_price) * raw.quantity) errors.push('ARITHMETIC_DISCREPANCY');
      if (product && cents(raw.unit_price) !== cents(product.approved_selling_price)) errors.push('UNAUTHORIZED_PRICE');
    }
    return { record_id: hash([raw,i]), original: structuredClone(raw), status: errors.length ? 'QUARANTINED' : 'VERIFIED', errors, reasons: errors.map(c => ANOMALY_REASONS[c] || c), warnings, product: product || null };
  });
}
export function inventoryMath(input, units, days = 30) {
  const required = ['stock_on_hand','confirmed_incoming','committed_stock','lead_time_days','safety_stock','target_inventory','minimum_order_quantity','pack_size'];
  const missing = required.filter(k => !number(input?.[k]) || input[k] < 0 || !Number.isSafeInteger(input[k]));
  if (!input?.pack_size) missing.push('positive_pack_size');
  if (!number(units) || units < 0 || !Number.isInteger(units) || !Number.isInteger(days) || days <= 0) missing.push('validated_demand_window');
  if (missing.length) return { status: 'BLOCKED', missing };
  const demand = units / days, position = input.stock_on_hand + input.confirmed_incoming - input.committed_stock;
  const threshold = Math.ceil(demand * input.lead_time_days) + input.safety_stock;
  const deficit = Math.max(0, input.target_inventory - position);
  const quantity = deficit ? Math.ceil(Math.max(deficit,input.minimum_order_quantity) / input.pack_size) * input.pack_size : 0;
  return { status: 'CALCULATED', average_daily_demand: demand, inventory_position: position, reorder_threshold: threshold, coverage_days: demand ? input.stock_on_hand / demand : null, required_quantity: position < threshold ? quantity : 0 };
}
export function analyze(rows, reference) {
  if (!date(reference)) throw Object.assign(new Error('An explicit valid reference date is required'), { status: 400 });
  const end = Date.parse(reference) + 86400000;
  const periods = [2,1].map(n => ({ start: new Date(end - n*30*86400000).toISOString().slice(0,10), end: new Date(end - (n-1)*30*86400000 - 86400000).toISOString().slice(0,10) }));
  const valid = rows.filter(r => r.status === 'VERIFIED');
  const metrics = periods.map(p => {
    const selected = valid.filter(r => r.original.purchase_date >= p.start && r.original.purchase_date <= p.end);
    const products = Object.create(null);
    for (const {original:r,record_id} of selected) {
      const m = products[r.product_id] ||= { product_id:r.product_id, units:0, revenue_cents:0, evidence:[] };
      m.units += r.quantity; m.revenue_cents += cents(r.total_amount); m.evidence.push(record_id);
    }
    const customerCounts = Object.create(null);
    selected.forEach(r => customerCounts[r.original.customer_id] = (customerCounts[r.original.customer_id] || 0)+1);
    const revenue_cents = selected.reduce((s,r) => s+cents(r.original.total_amount),0);
    return { ...p, transactions:selected.length, units:selected.reduce((s,r)=>s+r.original.quantity,0), revenue:revenue_cents/100, purchasing_customers:Object.keys(customerCounts).length, repeat_purchase_rate:Object.keys(customerCounts).length ? Object.values(customerCounts).filter(n=>n>=2).length/Object.keys(customerCounts).length : 0, average_order_value:selected.length ? revenue_cents/100/selected.length : 0, products:Object.values(products) };
  });
  const productIds = [...new Set(metrics.flatMap(m=>m.products.map(p=>p.product_id)))];
  const growth = productIds.map(id => { const previous=metrics[0].products.find(p=>p.product_id===id)?.units || 0, current=metrics[1].products.find(p=>p.product_id===id)?.units || 0; return { product_id:id, previous,current,growth_percent:previous ? (current-previous)/previous*100 : null, trend:previous ? current>previous?'GROWING':current<previous?'DECLINING':'UNCHANGED':current?'NEW_SALES_ACTIVITY':'NO_SALES' }; });
  return { reference_date:reference, periods:metrics, growth, quarantined:rows.length-valid.length, currency:'SGD', basis:'Observed validated sandbox records; no forecasts' };
}
export function importBatch(tenant, input) {
  const state=load(tenant);
  if (input.filename !== 'AIVORA_Coffee_SGD_Anomaly_and_Reorder.xlsx') throw Object.assign(new Error('Only the approved workbook filename is accepted; answer keys are forbidden'), {status:400});
  if (!/^[a-f0-9]{64}$/.test(input.file_hash || '') || !input.batch_id || !Array.isArray(input.customers) || !Array.isArray(input.purchases) || !Array.isArray(input.inventory)) throw Object.assign(new Error('Workbook SHA-256, batch ID and explicitly mapped customer/purchase/inventory arrays required'), {status:400});
  if ([...input.customers,...input.purchases,...input.inventory].some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw Object.assign(new Error('Every mapped row must be an object'), {status:400});
  const content_hash=hash([input.customers,input.purchases,input.inventory]);
  const existing=state.batches.find(b=>b.batch_id===input.batch_id || b.file_hash===input.file_hash || b.content_hash===content_hash);
  if(existing) { if(existing.content_hash!==content_hash) throw Object.assign(new Error('Import identity conflict'),{status:409}); return {...existing,deduped:true}; }
  const batch={...structuredClone(input),content_hash,imported_at:new Date().toISOString(),is_sandbox:true};
  state.batches.push(batch); save(tenant,state);
  logEvent(get(tenant),{kind:'CUSTOMER_IMPORT',actor:'crm',is_sandbox:true,decision:'HOLD',note:'Raw mapped workbook batch persisted; financial validation remains separate'});
  return batch;
}
export function businessView(tenant, reference) {
  const state=load(tenant), native=searchCustomers(tenant,{pageSize:100000}).customers;
  const customers=[...native,...state.batches.flatMap(b=>b.customers)];
  const nativeRows=native.flatMap(c=>getPurchaseHistory(tenant,c.customer_id).purchases);
  const raw=[...nativeRows,...state.batches.flatMap(b=>b.purchases)];
  const catalog=dropshipList(), records=validateRows(raw,customers,catalog);
  const enriched=customers.map(c=>{ const contact_errors=[];
    if(c.email_address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email_address)) contact_errors.push('INVALID_EMAIL');
    if(c.phone_number && !/^\+?[\d ()-]{7,20}$/.test(c.phone_number)) contact_errors.push('INVALID_PHONE');
    if(typeof c.marketing_consent!=='boolean') contact_errors.push('CONSENT_UNVERIFIED');
    if(customers.filter(x=>x.customer_id===c.customer_id).length>1) contact_errors.push('DUPLICATE_CUSTOMER_ID');
    const history=records.filter(r=>r.original.customer_id===c.customer_id && r.status==='VERIFIED');
    return {...c,contact_errors,contact_reasons:contact_errors.map(c=>ANOMALY_REASONS[c]||c),total_orders:history.length,total_purchase_amount:history.reduce((s,r)=>s+cents(r.original.total_amount),0)/100,currency:'SGD',customer_category:contact_errors.length?'REQUIRES_REVIEW':history.length>=2?'REPEAT':history.length?'NEW':'NO_PURCHASE_HISTORY'};
  });
  const selectedReference=reference || raw.filter(r=>date(r.purchase_date)).map(r=>r.purchase_date).sort().at(-1);
  const analysis=selectedReference ? analyze(records,selectedReference) : null;
  const inventoryRows=state.batches.flatMap(b=>b.inventory);
  const inventory=inventoryRows.map(i=>({ ...i,calculation:!analysis || !records.some(r=>r.status==='VERIFIED' && r.original.product_id===i.product_id) || inventoryRows.filter(x=>x.product_id===i.product_id).length!==1 ? {status:'BLOCKED',missing:['unique_inventory_and_verified_demand']} : inventoryMath(i,analysis.periods[1].products.find(p=>p.product_id===i.product_id)?.units || 0) }));
  return {customers:enriched,records,batches:state.batches.map(b=>({batch_id:b.batch_id,filename:b.filename,file_hash:b.file_hash,imported_at:b.imported_at,customers:b.customers.length,purchases:b.purchases.length,inventory:b.inventory.length})),analysis,inventory,orders:state.orders,events:state.events,catalog,unresolved_blockers:['Mapped JSON import available; native XLSX decoding not integrated','Online membership and durable schema integration blocked','Supplier costs, budget and reliable inventory must be provided','Purchase-order PDF generation not integrated','Executive audio synthesis not integrated'],mode:'EXPLICIT_OFFLINE_SANDBOX'};
}
export function runAnalysis(tenant,reference) {
  const result=businessView(tenant,reference), state=load(tenant);
  state.events=[{id:randomUUID(),ts:new Date().toISOString(),line:'Stored customer, purchase and master catalog records retrieved',status:'VERIFIED'},{id:randomUUID(),ts:new Date().toISOString(),line:`Deterministic validation: ${result.records.filter(r=>r.status==='VERIFIED').length} verified; ${result.records.filter(r=>r.status!=='VERIFIED').length} quarantined`,status:'VERIFIED'},{id:randomUUID(),ts:new Date().toISOString(),line:result.analysis?'Two non-overlapping 30-day periods calculated':'Analysis blocked: no valid reference date or purchase dataset',status:result.analysis?'VERIFIED':'BLOCKED'}];
  save(tenant,state); return {...result,events:state.events,business:true};
}
export function procurementGuard(config, quantity, committed = 0) {
  const missing=['supplier_id','supplier_verified','unit_cost','budget','currency','costs_complete'].filter(k=>config?.[k]===undefined || config[k]===null);
  if(missing.length || config.supplier_verified!==true || config.costs_complete!==true || config.currency!=='SGD' || !money(config.unit_cost) || config.unit_cost<=0 || !money(config.budget) || !Number.isSafeInteger(quantity) || quantity<=0) return {status:'BLOCKED',missing,reason:'Reliable supplier, complete costs, SGD budget and positive integer quantity required'};
  const total=cents(config.unit_cost)*quantity;
  if(!Number.isSafeInteger(total) || total+committed>cents(config.budget)) return {status:'BLOCKED',reason:'BUDGET_DENIED'};
  return {status:'VALIDATED',total:total/100};
}
export function purchaseOrderAction(tenant,input) {
  const state=load(tenant);
  if(input.action==='prepare') {
    const view=businessView(tenant,input.reference_date);
    const inventory=view.inventory.find(i=>i.product_id===input.product_id);
    if(!view.catalog.some(p=>p.product_id===input.product_id) || !inventory || inventory.calculation.status!=='CALCULATED' || inventory.calculation.required_quantity<=0) throw Object.assign(new Error('BLOCKED: reliable replenishment evidence required'),{status:409});
    const quantity=inventory.calculation.required_quantity, config=input.config;
    const existing=state.orders.find(o=>o.product_id===input.product_id && !['REJECTED','CANCELLED'].includes(o.status));
    if(existing) return {...existing,deduped:true};
    const guard=procurementGuard(config,quantity,state.orders.filter(o=>!['REJECTED','CANCELLED'].includes(o.status)).reduce((s,o)=>s+cents(o.total),0));
    if(guard.status!=='VALIDATED') throw Object.assign(new Error(guard.reason),{status:409});
    const order={id:randomUUID(),product_id:input.product_id,quantity,config:structuredClone(config),total:guard.total,version:1,status:'AWAITING_APPROVAL',is_sandbox:true,sent_to_supplier:false,evidence:inventory};
    order.action_hash=hash([order.id,order.version,order.product_id,quantity,config]); state.orders.push(order); save(tenant,state); return order;
  }
  const order=state.orders.find(o=>o.id===input.id);
  if(!order) throw Object.assign(new Error('Order not found'),{status:404});
  if(input.action==='approve') {
    if(input.action_hash!==order.action_hash || input.version!==order.version || order.status==='REJECTED') throw Object.assign(new Error('Exact-action approval mismatch'),{status:409});
    const guard=procurementGuard(order.config,order.quantity,state.orders.filter(o=>o.id!==order.id&&!['REJECTED','CANCELLED'].includes(o.status)).reduce((s,o)=>s+cents(o.total),0));
    if(guard.status!=='VALIDATED') throw Object.assign(new Error(guard.reason),{status:409});
    order.status='APPROVED_SANDBOX'; order.approved_at ||= new Date().toISOString();
  } else if(input.action==='amend') {
    if (order.status === 'REJECTED' || input.quantity % order.evidence.pack_size !== 0 || input.quantity < order.evidence.minimum_order_quantity) throw Object.assign(new Error('Amendment violates order state, minimum quantity or pack size'), {status:409});
    const guard=procurementGuard(order.config,input.quantity,state.orders.filter(o=>o.id!==order.id&&!['REJECTED','CANCELLED'].includes(o.status)).reduce((s,o)=>s+cents(o.total),0));
    if(guard.status!=='VALIDATED') throw Object.assign(new Error(guard.reason),{status:409});
    order.amendments ||= []; order.amendments.push({quantity:order.quantity,version:order.version,action_hash:order.action_hash,approved_at:order.approved_at || null});
    order.quantity=input.quantity; order.total=guard.total; order.version++; order.status='AWAITING_APPROVAL'; order.approved_at=null; order.action_hash=hash([order.id,order.version,order.product_id,order.quantity,order.config]);
  } else if(input.action==='reject') order.status='REJECTED';
  else throw Object.assign(new Error('Real supplier submission and document generation BLOCKED'),{status:409});
  save(tenant,state); return order;
}
