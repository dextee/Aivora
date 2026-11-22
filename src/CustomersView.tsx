import { useEffect, useState } from "react";

/* My Customers — native customer + purchase-history dashboard (no external CRM). Statistics computed from
 * stored records; mock data labelled; follow-ups are drafts only (never SENT); the automation-healing and
 * RogueAI export-guard demos run locally. */
interface Cust { customer_id: string; customer_name: string; customer_category: string; total_orders: number; total_purchase_amount: number; currency: string; last_purchase_date: string | null; is_mock_data: boolean; }
interface Rep { total_customers: number; new_customers: number; repeat_customers: number; vip_customers: number; inactive_customers: number; total_orders: number; total_purchase_value: number; avg_order_value: number; data_mode: string; }

export function CustomersView() {
  const [rep, setRep] = useState<Rep | null>(null);
  const [rows, setRows] = useState<Cust[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [csv, setCsv] = useState("customer_name,phone_number,email_address\nTest Buyer,65-90000000,test@example.test");
  const [log, setLog] = useState<string[]>([]);
  const [fu, setFu] = useState<any>(null);
  const push = (s: string) => setLog((l) => [s, ...l].slice(0, 12));

  async function load() {
    try {
      const r = await (await fetch(`/api/odai/customers/report?_t=${Date.now()}`)).json(); setRep(r);
      const s = await (await fetch(`/api/odai/customers?_t=${Date.now()}&q=${encodeURIComponent(q)}&category=${cat}`)).json(); setRows(s.customers || []);
    } catch { /* ignore */ }
  }
  useEffect(() => { void load(); }, [q, cat]);

  async function seed() { await fetch(`/api/odai/customers/seed`, { method: "POST" }); push("Seeded labelled MOCK customers + purchases"); void load(); }
  async function runHeal() {
    const r = await (await fetch(`/api/odai/customers/heal-demo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ injectFailure: true, purchase: { customer_id: (rows[0] || {} as any).customer_id || "CUS-x", order_number: "HEAL-1", product_name: "Nanyang Gold Kopi", quantity: 1, unit_price: 19.9, currency: "MYR" } }) })).json();
    push(`AUTOMATION-HEALING: exactly_one=${r.exactly_one} attempts=${r.attempts} · ${r.sequence.join(" → ")}`); void load();
  }
  async function runRogue() {
    const bad = await (await fetch(`/api/odai/customers/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "mkt-untrusted" }) })).json();
    const good = await (await fetch(`/api/odai/customers/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "mkt-approved" }) })).json();
    push(`ROGUEAI SHIELD: untrusted export blocked=${!!bad.blocked} (revoked+quarantined); approved export scope="${good.scope}"`);
  }
  async function doImport() {
    const parsed = csv.trim().split("\n").slice(1).map((line) => { const c = line.split(","); const h = csv.split("\n")[0].split(","); const o: any = {}; h.forEach((k, i) => (o[k] = c[i])); return o; });
    const r = await (await fetch(`/api/odai/customers/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: parsed }) })).json();
    push(`IMPORT: imported=${r.imported} rejected=${r.rejected.length} duplicates=${r.duplicates.length} (no fabrication)`); void load();
  }
  async function follow(id: string) { const r = await (await fetch(`/api/odai/customers/${id}/followup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "repeat" }) })).json(); setFu(r); push(`FOLLOW-UP drafted (status ${r.status}) — external_delivery=${r.external_delivery}`); }

  const card: React.CSSProperties = { border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 14 };
  const stat = (l: string, v: any) => <div style={{ textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 800 }}>{v}</div><div style={{ fontSize: 11, color: "var(--ink2)" }}>{l}</div></div>;

  return (
    <div className="view" style={{ padding: 16, maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>👥 Customer Intelligence {rep && <small style={{ color: "#e0a23a" }}>({rep.data_mode})</small>}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
          {rep && <>{stat("Total", rep.total_customers)}{stat("New", rep.new_customers)}{stat("Repeat", rep.repeat_customers)}{stat("VIP", rep.vip_customers)}{stat("Inactive", rep.inactive_customers)}{stat("Orders", rep.total_orders)}{stat("Value", rep.total_purchase_value)}{stat("Avg order", rep.avg_order_value)}</>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button className="q4send" style={{ padding: "7px 12px" }} onClick={() => void seed()}>Seed mock data</button>
          <button className="q4send" style={{ padding: "7px 12px", background: "#7a3fb3" }} onClick={() => void runHeal()}>Run automation-healing demo</button>
          <button className="q4send" style={{ padding: "7px 12px", background: "#b3453f" }} onClick={() => void runRogue()}>Run RogueAI export-guard demo</button>
        </div>
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Customers</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="q4input" style={{ flex: 1 }} placeholder="Search name/phone/email" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="q4input" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All</option><option>NEW</option><option>REPEAT</option><option>VIP</option><option>INACTIVE</option><option>POTENTIAL</option></select>
        </div>
        <table style={{ width: "100%", fontSize: 12, marginTop: 8, borderCollapse: "collapse" }}>
          <thead><tr style={{ color: "var(--ink2)", textAlign: "left" }}><th>Name</th><th>Category</th><th>Orders</th><th>Spend</th><th></th></tr></thead>
          <tbody>{rows.map((c) => (<tr key={c.customer_id} style={{ borderTop: "1px solid var(--line,#2a2f45)" }}><td>{c.customer_name}{c.is_mock_data && <small style={{ color: "#e0a23a" }}> ·mock</small>}</td><td>{c.customer_category}</td><td>{c.total_orders}</td><td>{c.currency} {c.total_purchase_amount}</td><td><button className="q4send" style={{ padding: "3px 8px", fontSize: 11 }} onClick={() => void follow(c.customer_id)}>Follow-up</button></td></tr>))}</tbody>
        </table>
        {fu && <p style={{ fontSize: 12, marginTop: 8 }}>📨 {fu.message}<br /><small style={{ color: "#e0a23a" }}>status {fu.status} · {fu.external_delivery}</small></p>}
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Import CSV (validated · deduped · no fabrication)</h3>
        <textarea className="q4input" rows={3} value={csv} onChange={(e) => setCsv(e.target.value)} />
        <button className="q4send" style={{ marginTop: 8, padding: "7px 12px" }} onClick={() => void doImport()}>Import</button>
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Activity</h3>
        {log.length === 0 && <p style={{ fontSize: 12, color: "var(--ink2)" }}>No actions yet.</p>}
        {log.map((l, i) => <p key={i} style={{ fontSize: 12, margin: "4px 0" }}>• {l}</p>)}
      </section>
    </div>
  );
}
