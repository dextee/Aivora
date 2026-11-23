import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from './auth';
export type BusinessPage = 'contacts' | 'purchases' | 'orders' | 'intelligence';

/* Executive audio synthesis via the browser SpeechSynthesis API (no server TTS key needed). */
function speak(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1; u.lang = "en-SG";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return true;
  } catch { return false; }
}
export function BusinessView({ page, onTalk }: { page: BusinessPage; onTalk(): void }) {
  const [data,setData]=useState<any>(null), [error,setError]=useState(''), [q,setQ]=useState(''), [filter,setFilter]=useState(''), [reference,setReference]=useState(''), [customer,setCustomer]=useState(''), [sort,setSort]=useState('name'), [tab,setTab]=useState('records'), [busy,setBusy]=useState(false), [revealed,setRevealed]=useState(0);
  const consoleRef=useRef<HTMLDivElement>(null);
  const [importPreview,setImportPreview]=useState<any>(null);
  async function previewExcel(file:File) {
    setBusy(true); setError('');
    try {
      if(file.size>10*1024*1024) throw new Error('Workbook must be smaller than 10 MB');
      if(!/^AIVORA_Coffee_SGD_Anomaly_and_Reorder(?: \(\d+\))?\.xlsx$/i.test(file.name)) throw new Error('Select the approved coffee workbook (.xlsx), not an answer key');
      const bytes=await file.arrayBuffer();
      const ExcelJS=await import('exceljs'); const workbook=new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      const sheetRows=(name:string,required:string[])=>{
        const sheet=workbook.getWorksheet(name); if(!sheet) throw new Error(`Missing worksheet: ${name}`);
        const headers:Record<string,number>={}; sheet.getRow(1).eachCell((c,i)=>{headers[c.text.trim()]=i;});
        for(const h of required) if(!headers[h]) throw new Error(`${name}: missing column ${h}`);
        const result:any[]=[]; sheet.eachRow((row,n)=>{if(n===1)return;const out:any={};for(const [h,i] of Object.entries(headers)){const cell=row.getCell(i);if(cell.type===ExcelJS.ValueType.Formula)throw new Error(`${name} row ${n}: formulas require manual review`);out[h]=cell.value;}if(Object.values(out).some(v=>v!==null))result.push(out);});return result;
      };
      const cr=sheetRows('Customers',['Customer ID','Name','Address','Phone','Email','Consent']);
      const pr=sheetRows('Purchase History',['Order ID','Customer ID','Product','Date','Qty','Total']);
      const ir=sheetRows('Inventory',['Product','Unit Price (SGD)','Stock On Hand','Reserved Units','Incoming Units','Lead Time (Days)','Safety Stock','Target Cover (Days)','Pack Size']);
      const catalog=data?.catalog||[];
      const pid=(name:unknown)=>catalog.find((p:any)=>p.name===name)?.product_id||String(name??'');
      const iso=(v:any)=>v instanceof Date?v.toISOString().slice(0,10):typeof v==='number'?new Date(Date.UTC(1899,11,30)+v*86400000).toISOString().slice(0,10):String(v??'');
      const digest=await crypto.subtle.digest('SHA-256',bytes);const file_hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      setImportPreview({filename:'AIVORA_Coffee_SGD_Anomaly_and_Reorder.xlsx',original_filename:file.name,file_hash,batch_id:`excel-${file_hash}`,customers:cr.map(r=>({customer_id:r['Customer ID'],customer_name:r.Name,name:r.Name,address:r.Address,phone_number:String(r.Phone??''),email_address:r.Email,marketing_consent:r.Consent==='Yes'?true:r.Consent==='No'?false:null,source_row:r})),purchases:pr.map(r=>({order_number:r['Order ID'],customer_id:r['Customer ID'],product_id:pid(r.Product),product_name:r.Product,purchase_date:iso(r.Date),quantity:r.Qty,total_amount:r.Total,unit_price:ir.find(i=>i.Product===r.Product)?.['Unit Price (SGD)']??null,unit_price_basis:'Inventory reference price; transaction unit price not supplied',currency:'SGD',source_row:r})),inventory:ir.map(r=>({product_id:pid(r.Product),stock_on_hand:r['Stock On Hand'],committed_stock:r['Reserved Units'],confirmed_incoming:r['Incoming Units'],lead_time_days:r['Lead Time (Days)'],safety_stock:r['Safety Stock'],pack_size:r['Pack Size'],target_cover_days:r['Target Cover (Days)'],source_row:r}))});
    }catch(e){setError((e as Error).message);setImportPreview(null);}finally{setBusy(false);}
  }
  async function request(path:string, body?:unknown) {
    const token=getAccessToken(); const res=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const j=await res.json(); if(!res.ok) throw new Error(j.error || `HTTP ${res.status}`); return j;
  }
  async function refresh() { try {setData(await request(`/api/odai/business?${new URLSearchParams({reference_date:reference,_t:String(Date.now())})}`));setError('');}catch(e){setError((e as Error).message);setData(null);} }
  useEffect(()=>{void refresh();},[page,reference]);
  useEffect(()=>{const timer=setInterval(()=>setRevealed(n=>Math.min(n+1,data?.events?.length || 0)),50);return ()=>clearInterval(timer);},[data]);
  useEffect(()=>{if(consoleRef.current) consoleRef.current.scrollTop=consoleRef.current.scrollHeight;},[revealed]);
  async function action(path:string, body:unknown) {setBusy(true);try{const j=await request(path,body);if(j.business){setData(j);setRevealed(0);}else await refresh();setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);} }
  const titles={contacts:'Customer Contacts',purchases:'Purchase History',orders:'Purchase Orders',intelligence:'Business Intelligence'};
  const match=(value:unknown)=>JSON.stringify(value).toLowerCase().includes(q.toLowerCase());
  const rows=(data?.records || []).filter((r:any)=>match(r.original)&&(!filter||r.status===filter)&&(!customer||r.original.customer_id===customer));
  const contacts=(data?.customers || []).filter((c:any)=>match(c)&&(!filter||c.customer_category===filter)).sort((a:any,b:any)=>sort==='value'?b.total_purchase_amount-a.total_purchase_amount:String(a.customer_name).localeCompare(String(b.customer_name)));
  /* V43 customer dashboard (mockup) — computed from the live dataset, no invented numbers */
  const lastOrderOf=(cid:string)=>{const rs=data?.records?.filter((r:any)=>r.original.customer_id===cid&&r.status==='VERIFIED')||[];return rs.length?rs.map((r:any)=>r.original.purchase_date).sort().pop():null;};
  const ctab=(t:string)=>{setTab(t);setFilter('');};
  const stats=data?{total:data.customers.length,active:data.customers.filter((c:any)=>c.total_orders>0).length,fresh:data.customers.filter((c:any)=>c.customer_category==='NEW').length,aov:(()=>{const v=data.customers.reduce((s:number,c:any)=>s+(c.total_purchase_amount||0),0);const o=data.customers.reduce((s:number,c:any)=>s+(c.total_orders||0),0);return o?v/o:0;})()}:null;
  const exportContacts=()=>{if(!data)return;const blob=new Blob([JSON.stringify(contacts,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='aivora-customers.json';a.click();URL.revokeObjectURL(a.href);};
  return <main className="view inbox-view business-view"><div className="inbox-heading"><h1>{titles[page]}</h1><button onClick={()=>void refresh()}>Refresh</button></div><p>AIVORA ODAI V0.9BETA · SGD · sandbox only</p>{error&&<section className="inbox-card" role="alert">{error}</section>}
    {page!=='contacts'&&<section className="inbox-card"><label>Analysis reference date<input type="date" value={reference} onChange={e=>setReference(e.target.value)}/></label><p>Blank uses the latest valid purchase date, not today's clock.</p><button className="inbox-primary" disabled={busy} onClick={()=>void action('/api/odai/submit',{text:'AIVORA, how is my business doing today?',reference_date:reference||undefined})}>Analyze stored business records</button></section>}
    {page==='contacts'&&<section className="inbox-card"><h2>Import Excel</h2><button className="inbox-primary" disabled={busy||!data} onClick={()=>document.getElementById('excel-customer-import')?.click()}>Import Excel workbook</button><input id="excel-customer-import" hidden type="file" accept=".xlsx" onChange={e=>{const f=e.target.files?.[0];if(f)void previewExcel(f);e.target.value='';}}/><p>Reads Customers, Purchase History and Inventory. Original rows are preserved; no automatic corrections.</p>{importPreview&&<><p>{importPreview.original_filename}</p><p>{importPreview.customers.length} customers · {importPreview.purchases.length} purchases · {importPreview.inventory.length} inventory rows</p><p>Transaction unit prices use Inventory reference prices, explicitly labelled. Missing inventory target units and minimum order quantities remain unset.</p><button disabled={busy} onClick={async()=>{setBusy(true);try{await request('/api/odai/business/import',importPreview);setImportPreview(null);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Confirm import</button><button onClick={()=>setImportPreview(null)}>Cancel</button></>}</section>}
    {data&&<><section className="inbox-card"><p>{data.mode}</p><p>{data.customers.length} contacts · {data.records.length} original purchases · {data.records.filter((r:any)=>r.status==='VERIFIED').length} verified · {data.records.filter((r:any)=>r.status==='QUARANTINED').length} quarantined</p></section>
    {page==='contacts'&&<details className="cust-adv"><summary>Advanced JSON import</summary><p>Excel import is available above. Mapped JSON remains supported for existing integrations.</p><input aria-label="Import mapped JSON" type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];if(f) void f.text().then(t=>action('/api/odai/business/import',JSON.parse(t))).catch(e=>setError(e.message));}}/>{data.batches.map((b:any)=><p key={b.batch_id}>{b.filename} · {b.imported_at} · {b.customers}/{b.purchases}/{b.inventory}<br/><code>{b.file_hash}</code></p>)}</details>}
    {page!=='contacts'&&<label>Search<input type="search" value={q} onChange={e=>setQ(e.target.value)}/></label>}
    {(page==='purchases')&&<label>Filter<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">All</option>{['VERIFIED','QUARANTINED'].map(v=><option key={v}>{v}</option>)}</select></label>}
    {page==='contacts'&&data&&stats&&<section className="cust-dash">
      <div className="cust-stats">
        <div className="cust-stat"><b>{stats.total}</b><label>Total Customers</label></div>
        <div className="cust-stat"><b>{stats.active}</b><label>Active Customers</label></div>
        <div className="cust-stat"><b>{data.catalog.length}</b><label>Products</label></div>
        <div className="cust-stat"><b>{data.inventory.filter((i:any)=>i.calculation?.shortage===true||i.calculation?.replenishment_quantity>0).length}</b><label>Reorder recommendations</label></div>
      </div>
      <div className="cust-actions">
        <button className="cust-add" onClick={()=>setTab('records')}>+ Add Customer</button>
        <button className="cust-import" disabled={busy} onClick={()=>document.getElementById('excel-customer-import')?.click()}>Import Excel</button>
        <input id="cust-import-file" hidden type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];if(f) void f.text().then(t=>action('/api/odai/business/import',JSON.parse(t))).catch(e=>setError(e.message));}}/>
      </div>
      <nav className="cust-tabs">
        <button className={tab==='records'?'on':''} onClick={()=>ctab('records')}>Customers</button>
        <button className={tab==='purchases'?'on':''} onClick={()=>ctab('purchases')}>Purchases</button>
        <button className={tab==='insights'?'on':''} onClick={()=>ctab('insights')}>Insights</button>
        <button className={tab==='anomalies'?'on':''} onClick={()=>ctab('anomalies')}>Anomalies</button>
      </nav>
      {tab==='purchases'&&<section className="inbox-card">{rows.map((r:any)=><p key={r.record_id}>{r.original.order_number} · {r.product?.name||r.original.product_name} · {r.original.quantity} units · SGD {r.original.total_amount} · {r.status}</p>)}{!rows.length&&<p>No purchase records available.</p>}</section>}
      {tab==='insights'&&<section className="inbox-card"><h2>Verified business insights</h2>{data.analysis?data.analysis.periods.map((p:any)=><p key={p.start}>{p.start} to {p.end} · SGD {p.revenue.toFixed(2)} · {p.units} units · {p.transactions} verified transactions</p>):<p>Import purchase records to calculate insights.</p>}</section>}
      {tab==='anomalies'&&<section className="inbox-card"><h2>Why these records are quarantined</h2><p>Each anomaly below is flagged by deterministic validation. The original record is preserved unchanged; nothing is auto-corrected or counted as revenue until reviewed.</p>
        {data.records.filter((r:any)=>r.errors.length).map((r:any)=><details key={r.record_id} className="anomaly-item"><summary>📦 {r.original.order_number||'(no order #)'} · {r.status}</summary>
          <ul className="anomaly-reasons">{(r.reasons||r.errors).map((reason:string,i:number)=><li key={i}><b>{r.errors[i]}</b> — {reason}</li>)}</ul>
          <p className="anomaly-meta">Customer {r.original.customer_id} · {r.original.product_id} · {r.original.purchase_date} · {r.original.quantity} × {r.original.unit_price} {r.original.currency}</p>
          <details><summary>Original evidence</summary><pre>{JSON.stringify(r.original,null,2)}</pre></details>
        </details>)}
        {contacts.filter((c:any)=>c.contact_errors?.length).map((c:any)=><details key={'c'+c.customer_id} className="anomaly-item"><summary>👤 {c.customer_name||c.customer_id} · contact requires review</summary>
          <ul className="anomaly-reasons">{(c.contact_reasons||c.contact_errors).map((reason:string,i:number)=><li key={i}><b>{c.contact_errors[i]}</b> — {reason}</li>)}</ul>
        </details>)}
        {!data.records.some((r:any)=>r.errors.length)&&!contacts.some((c:any)=>c.contact_errors?.length)&&<p>No recorded anomalies.</p>}
      </section>}
      <label className="cust-search">🔎 <input type="search" value={q} placeholder="Search customers by name or email" onChange={e=>setQ(e.target.value)}/></label>
      {tab==='records'&&<div className="cust-list">
        {contacts.map((c:any)=><article className="cust-card" key={c.customer_id}>
          <div className="cust-card-top"><h3>{c.customer_name||c.name||c.customer_id}</h3><span className={`cust-tag ${c.customer_category==='NO_PURCHASE_HISTORY'?'off':'on'}`}>{c.customer_category==='NO_PURCHASE_HISTORY'?'Inactive':'Active'}</span></div>
          <code>{c.customer_id} · G401 - Import Customer</code>
          <div className="cust-card-meta">
            <span>Last Order: <b>{lastOrderOf(c.customer_id)||'—'}</b></span>
            <span>Lifetime Value: <b>SGD {c.total_purchase_amount.toFixed(2)}</b></span>
          </div>
          {c.contact_errors?.length>0&&<div className="anomaly-banner">⚠️ Requires review: <ul className="anomaly-reasons">{(c.contact_reasons||c.contact_errors).map((reason:string,i:number)=><li key={i}>{reason}</li>)}</ul></div>}
          <button className="cust-view" onClick={()=>setCustomer(c.customer_id)}>View purchases</button>
          {customer===c.customer_id&&data.records.filter((r:any)=>r.original.customer_id===customer).map((r:any)=><p key={r.record_id} className="cust-order">{r.original.order_number} · {r.original.purchase_date} · {r.status} · {r.original.currency} {r.original.total_amount}{r.status==='QUARANTINED'&&r.reasons?.length&&<span className="anomaly-inline"> — {r.reasons.join(' ')}</span>}</p>)}
        </article>)}
        {!contacts.length&&<p className="cust-empty">No customers match — import the mapped JSON batch or clear the filters.</p>}
      </div>}
      <div className="cust-fab-wrap">
        <button className="cust-analyze" disabled={busy} onClick={()=>void action('/api/odai/submit',{text:'AIVORA, how is my business doing today?',reference_date:reference||undefined})}>Analyze My Business</button>
        <button className="cust-fab" aria-label="Analyze my business" disabled={busy} onClick={()=>void action('/api/odai/submit',{text:'AIVORA, how is my business doing today?',reference_date:reference||undefined})}>+</button>
      </div>
      <details className="cust-adv"><summary>Advanced: import batches, anomalies, sort, consent & contact review</summary>
        <label>Sort<select value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="value">Verified lifetime value</option></select></label>
        {data.batches.map((b:any)=><p key={b.batch_id}>{b.filename} · {b.imported_at} · {b.customers}/{b.purchases}/{b.inventory}<br/><code>{b.file_hash}</code></p>)}
        {data.records.filter((r:any)=>r.errors.length).map((r:any)=><article key={r.record_id}><h3>{r.original.order_number} · {r.status}</h3><ul className="anomaly-reasons">{(r.reasons||r.errors).map((reason:string,i:number)=><li key={i}><b>{r.errors[i]}</b> — {reason}</li>)}</ul><details><summary>Original evidence</summary><pre>{JSON.stringify(r.original,null,2)}</pre></details><p>Correction/release blocked: approved review policy required. Original unchanged.</p></article>)}
        {contacts.map((c:any)=><p key={'i'+c.customer_id}>{c.customer_name} · {c.phone_number||'Phone unavailable'} · {c.email_address||'Email unavailable'} · Consent: {String(c.marketing_consent??'unverified')} · Contact review: {(c.contact_reasons||c.contact_errors).join(' ')||'none'}</p>)}
      </details>
    </section>}
    {page==='purchases'&&<><label>Customer<select value={customer} onChange={e=>setCustomer(e.target.value)}><option value="">All</option>{data.customers.map((c:any)=><option key={c.customer_id} value={c.customer_id}>{c.customer_name}</option>)}</select></label>{rows.map((r:any)=><article className="inbox-card" key={r.record_id}>{r.product?.image&&<img className="business-product" src={r.product.image} alt={r.product.name}/>}<h3>{r.original.order_number}</h3><p>{r.original.customer_id} · {r.original.product_id} · {r.product?.name||r.original.product_name}</p><p>{r.original.purchase_date} · {r.original.quantity} units × {r.original.unit_price} · {r.original.currency} {r.original.total_amount}</p><p>{r.status}{r.errors.length?' · '+r.errors.join(', '):''}</p>{r.reasons?.length>0&&<ul className="anomaly-reasons">{r.reasons.map((reason:string,i:number)=><li key={i}>{reason}</li>)}</ul>}<details><summary>Preserved original record</summary><pre>{JSON.stringify(r.original,null,2)}</pre></details></article>)}</>}
    {page==='intelligence'&&<>{data.events.length>0&&<section className="business-console" ref={consoleRef} aria-label="Actual persisted execution events">{data.events.slice(0,revealed).map((e:any)=><details key={e.id}><summary>{e.ts} · {e.status} · {e.line}</summary><code>{e.id}</code></details>)}<span className="business-cursor">_</span></section>}{data.analysis?<><section className="inbox-card"><h2>Observed sales comparison</h2><button className="ba-ghost" onClick={()=>{const a=data.analysis;const top=[...a.periods[1].products].sort((x:any,y:any)=>y.units-x.units)[0];const name=data.catalog.find((c:any)=>c.product_id===top?.product_id)?.name||top?.product_id||"n/a";speak(`Executive briefing. Reference ${a.reference_date}. Latest period revenue ${a.periods[1].revenue.toFixed(2)} Singapore dollars across ${a.periods[1].transactions} valid transactions. Strongest product ${name} with ${top?.units||0} units. ${a.quarantined} records quarantined and excluded.`);}}>🔊 Read executive briefing</button><p>Reference: {data.analysis.reference_date}</p>{data.analysis.periods.map((p:any)=><div key={p.start}><h3>{p.start} to {p.end}</h3><p>SGD {p.revenue.toFixed(2)} · {p.units} units · {p.transactions} valid transactions</p><p>{p.purchasing_customers} purchasing customers · Repeat rate {(p.repeat_purchase_rate*100).toFixed(1)}% · AOV SGD {p.average_order_value.toFixed(2)}</p><meter aria-label={`Revenue ${p.start}`} min="0" max={Math.max(1,...data.analysis.periods.map((x:any)=>x.revenue))} value={p.revenue}/></div>)}</section>{data.analysis.growth.map((p:any)=><section className="inbox-card" key={p.product_id}><h3>{data.catalog.find((c:any)=>c.product_id===p.product_id)?.name||p.product_id}</h3><p>{p.previous} → {p.current} units · {p.growth_percent===null?p.trend:`${p.growth_percent.toFixed(1)}%`}</p></section>)}</>:<section className="inbox-card">Analysis BLOCKED: no purchase dataset/reference date available.</section>}{data.inventory.map((i:any)=><section className="inbox-card" key={i.product_id}><h3>Inventory: {i.product_id}</h3><pre>{JSON.stringify(i.calculation,null,2)}</pre></section>)}</>}
    {page==='orders'&&<><section className="inbox-card"><p>{data.orders.length} sandbox orders · {data.orders.filter((o:any)=>o.status==='AWAITING_APPROVAL').length} awaiting approval · 0 real submissions</p><p>Preparation requires reliable inventory evidence plus verified supplier, complete unit costs and budget. Missing inputs BLOCK preparation.</p><details><summary>Prepare from supplied procurement configuration</summary><label>Configuration JSON<input type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];if(f)void f.text().then(t=>action('/api/odai/business/orders',{...JSON.parse(t),action:'prepare',reference_date:reference||undefined})).catch(e=>setError(e.message));}}/></label></details></section>{data.orders.map((o:any)=><article className="inbox-card" key={o.id}><h3>{o.product_id}</h3><p>{o.id} · {o.status} · version {o.version}</p><p>{o.quantity} units · SGD {o.total.toFixed(2)} · supplier {o.config.supplier_id}</p><details><summary>Calculation and exact approval evidence</summary><pre>{JSON.stringify(o,null,2)}</pre></details><button disabled={busy||o.status!=='AWAITING_APPROVAL'} onClick={()=>void action('/api/odai/business/orders',{action:'approve',id:o.id,version:o.version,action_hash:o.action_hash})}>Approve exact sandbox action</button><button disabled={busy} onClick={()=>{const quantity=Number(window.prompt('Revised quantity; approval will be invalidated'));if(quantity)void action('/api/odai/business/orders',{action:'amend',id:o.id,quantity});}}>Modify quantity</button><button disabled={busy} onClick={()=>void action('/api/odai/business/orders',{action:'reject',id:o.id})}>Reject</button><div className="ba-actions"><a className="ba-ghost" href={`/api/odai/business/orders/${o.id}/pdf`} download>Download PO PDF</a><button className="ba-ghost" disabled={busy} onClick={()=>void action(`/api/odai/business/orders/${o.id}/document`,{})}>Store in My Documents</button></div><p>Supplier submission remains BLOCKED (sandbox). PDF is generated from the authoritative order record.</p></article>)}</>}
    <section className="inbox-card"><h2>Integration blockers</h2>{data.unresolved_blockers.map((b:string)=><p key={b}>{b}</p>)}</section></>}
    <button className="inbox-primary" onClick={onTalk}>Use existing voice and universal text entry</button>
  </main>;
}
