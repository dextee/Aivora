import { useEffect, useMemo, useState } from "react";

type Decision = { decision_id: string; decision_type: string; priority: string; tab: string; plain_language_title: string; plain_language_reason: string; exact_recommended_quantity: number | null; recommended_discount_percentage: number | null; recommended_offer_price: number | null; estimated_cost: number | null; supporting_metrics: Record<string, unknown>; supplier?: string | null; unit_cost?: number | null; budget_status?: string; consent?: boolean; channel?: string; discount_basis?: string; customer_ids?: string[]; product_ids?: string[]; source_evidence_ids?: string[]; analysis_period?: string | null; verification_method?: string };
type Plan = { reference: string | null; mode: string; stats: { recommended_actions: number; proposed_purchasing: number; customer_targets: number; discount_range: string | null; quarantined_records: number }; decisions: Decision[]; briefing: string };
type Cust = { customer_id: string; name: string; segment: string; lifetime_sales: number; last_purchase: string | null; days_since_last: number | null; favorite_product: string | null; suggested_quantity: number | null; proposed_discount_percent: number | null; final_offer_price: number | null; reason: string; channel: string; consent: boolean; eligible: boolean };

async function api(path: string, init?: RequestInit) {
  const token = localStorage.getItem("aivora.auth.token") || "";
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  const text = await res.text(); let data: any = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || res.statusText); return data;
}
const prioColor = (p: string) => (p === "CRITICAL" || p === "URGENT" ? "#b42318" : p === "HIGH" ? "#b54708" : "#475467");

export function BusinessActionView() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [top, setTop] = useState(5);
  const [tab, setTab] = useState("today");
  const [customers, setCustomers] = useState<Cust[]>([]);
  const [seg, setSeg] = useState("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [why, setWhy] = useState<string>("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = (t = top) => api(`/api/odai/action?top=${t}`).then(setPlan).catch((e) => setError(e.message));
  const loadCustomers = (s = seg) => api(`/api/odai/action/customers?segment=${s}&limit=50`).then((d) => setCustomers(d.customers || [])).catch((e) => setError(e.message));
  useEffect(() => { void load(top); }, [top]);
  useEffect(() => { void loadCustomers(seg); }, [seg]);

  const shown = useMemo(() => {
    if (!plan) return [];
    if (tab === "today") return plan.decisions;
    return plan.decisions.filter((d) => d.tab === tab);
  }, [plan, tab]);

  async function preparePo(d: Decision) {
    setBusy(d.decision_id); setNote(""); setError("");
    try { const r = await api("/api/odai/action/prepare-po", { method: "POST", body: JSON.stringify({ decision_id: d.decision_id }) }); setNote(`Purchase order ${r.order_id.slice(0, 8)} ${r.deduped ? "(existing, no duplicate)" : "created"} — ${r.quantity} units, S$${r.total}, status ${r.status}. See Purchase Orders.`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  async function prepareEmails(ids: string[]) {
    setBusy("emails"); setNote(""); setError("");
    try { const r = await api("/api/odai/action/emails", { method: "POST", body: JSON.stringify({ customer_ids: ids }) }); setNote(`${r.prepared} personalized draft(s) prepared, ${r.skipped} skipped (consent). Nothing sent — dispatch needs owner approval + Gmail authorization.`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  const copyBriefing = () => { if (plan?.briefing) { void navigator.clipboard?.writeText(plan.briefing); setNote("Daily briefing copied to clipboard."); } };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="ba">
      <p className="ba-crumb">Business Intelligence / Business Decisions</p>
      <h1 className="ba-title">Your Business Action Plan</h1>
      {error && <p className="ba-error" role="alert">{error}</p>}
      {note && <p className="ba-note">{note}</p>}

      {plan && (
        <section className="ba-hero">
          <p className="ba-hello">🤖 Good morning, Boss!</p>
          <p>{plan.briefing.split(". ")[0]}.</p>
          <button className="ba-brief" onClick={copyBriefing}>🔊 Copy Daily Briefing</button>
        </section>
      )}

      {plan && (
        <section className="ba-stats">
          <div className="ba-stat"><span>Recommended actions</span><strong>{plan.stats.recommended_actions}</strong></div>
          <div className="ba-stat"><span>Proposed purchasing</span><strong>S${plan.stats.proposed_purchasing.toLocaleString()}</strong></div>
          <div className="ba-stat"><span>Customer targets</span><strong>{plan.stats.customer_targets}</strong></div>
          <div className="ba-stat"><span>Proposed discounts</span><strong>{plan.stats.discount_range || "n/a"}</strong></div>
        </section>
      )}
      {plan && plan.stats.quarantined_records > 0 && <p className="ba-warn">{plan.stats.quarantined_records} quarantined records excluded from all figures (see Customer → Anomalies).</p>}

      <div className="ba-topbar">
        <span>Show top actions</span>
        <select value={top} onChange={(e) => setTop(Number(e.target.value))} aria-label="Top actions count">
          {[3, 5, 10, 20].map((n) => <option key={n} value={n}>Top {n}</option>)}
        </select>
      </div>
      <div className="ba-tabs" role="tablist">
        {[["today", "Today"], ["purchase", "Purchase"], ["customers", "Customers"], ["products", "Products"]].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <section className="ba-cards">
        {shown.length === 0 && <p className="ba-empty">No justified actions in this view right now — AIVORA only recommends what the data supports.</p>}
        {shown.map((d, i) => (
          <article key={d.decision_id} className="ba-card">
            <div className="ba-card-head"><span className="ba-prio" style={{ color: prioColor(d.priority) }}>{d.priority === "CRITICAL" || d.priority === "URGENT" ? "🛒 " : ""}{d.priority}</span><span className="ba-idx">#{i + 1}</span></div>
            <h3>{d.plain_language_title}</h3>
            <p className="ba-reason">{d.plain_language_reason}</p>
            {d.decision_type === "PURCHASE" && (
              <div className="ba-cost"><span>Purchase cost</span><strong>S${(d.estimated_cost ?? 0).toLocaleString()}</strong>
                <small>stock {(d.supporting_metrics as any).stock_on_hand} · {(d.supporting_metrics as any).avg_daily_sales?.toFixed?.(1)} /day · lead {(d.supporting_metrics as any).lead_time_days}d · supplier {d.supplier || "n/a"} · budget {d.budget_status}</small>
              </div>
            )}
            {d.decision_type === "CUSTOMER_CONTACT" && (
              <div className="ba-cost"><span>Offer</span><strong>{d.recommended_discount_percentage}% off → S${d.recommended_discount_percentage != null && d.recommended_offer_price != null ? d.recommended_offer_price : "—"}</strong>
                <small>{d.discount_basis} · channel {d.channel}</small>
              </div>
            )}
            <div className="ba-actions">
              {d.decision_type === "PURCHASE" && <button className="ba-primary" disabled={!!busy} onClick={() => void preparePo(d)}>{busy === d.decision_id ? "…" : "Prepare Purchase Order"}</button>}
              {d.decision_type === "CUSTOMER_CONTACT" && <button className="ba-primary" disabled={!!busy} onClick={() => void prepareEmails(d.customer_ids || [])}>{busy === d.decision_id ? "…" : "Prepare Customer Emails"}</button>}
              <button className="ba-ghost" onClick={() => setWhy(why === d.decision_id ? "" : d.decision_id)}>Explain Why</button>
            </div>
            {why === d.decision_id && <pre className="ba-why">{JSON.stringify({ metrics: d.supporting_metrics, evidence: d.source_evidence_ids, period: d.analysis_period, verification: d.verification_method }, null, 2)}</pre>}
          </article>
        ))}
      </section>

      <section className="ba-contact">
        <h2>Who Should I Contact?</h2>
        <p className="ba-sub">Ranked from actual validated purchase history · policy-bounded offers · consent-gated</p>
        <div className="ba-tabs" role="tablist">
          {[["ALL", "All"], ["VIP", "VIP"], ["INACTIVE", "Inactive"], ["DECLINING", "Declining"]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={seg === id} className={seg === id ? "on" : ""} onClick={() => setSeg(id)}>{label}</button>
          ))}
        </div>
        <div className="ba-selbar"><span>Selected customers</span><strong>{selected.size}</strong><button className="ba-ghost" onClick={() => setSelected(new Set())}>Deselect all</button></div>
        {customers.length === 0 && <p className="ba-empty">No eligible customers in this segment.</p>}
        {customers.map((c) => (
          <article key={c.customer_id} className={`ba-cust${selected.has(c.customer_id) ? " sel" : ""}`}>
            <div className="ba-cust-head">
              <label className="ba-check"><input type="checkbox" checked={selected.has(c.customer_id)} onChange={() => toggle(c.customer_id)} aria-label={`Select ${c.name}`} /><span>✔</span></label>
              <div><b>{c.name}</b><small>{c.customer_id}</small></div>
              <span className="ba-seg" data-seg={c.segment}>{c.segment}</span>
            </div>
            <dl className="ba-cust-grid">
              <div><dt>Lifetime sales</dt><dd>S${c.lifetime_sales.toLocaleString()}</dd></div>
              <div><dt>Last purchase</dt><dd>{c.days_since_last != null ? `${c.days_since_last} days ago` : "never"}</dd></div>
              <div><dt>Favorite product</dt><dd>{c.favorite_product || "—"}</dd></div>
              <div><dt>Proposed discount</dt><dd>{c.proposed_discount_percent != null ? c.proposed_discount_percent + "%" : "—"}</dd></div>
              <div><dt>Suggested offer quantity</dt><dd>{c.suggested_quantity != null ? c.suggested_quantity + " packs" : "—"}</dd></div>
              <div><dt>Channel / consent</dt><dd>{c.channel}</dd></div>
            </dl>
            <p className="ba-creason">{c.reason}</p>
          </article>
        ))}
        <div className="ba-actions">
          <a className="ba-ghost" href="/api/odai/action/export.csv?segment={seg}&limit=50" download>Download CSV</a>
          <a className="ba-ghost" href="/api/odai/action/export.xlsx?segment={seg}&limit=50" download>Download Excel</a>
          <button className="ba-primary" disabled={!selected.size || !!busy} onClick={() => void prepareEmails([...selected])}>{busy === "emails" ? "…" : `Prepare Emails (${selected.size})`}</button>
        </div>
      </section>
    </div>
  );
}
