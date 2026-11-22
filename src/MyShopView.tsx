import { useEffect, useState } from "react";

/* My Shop (MAIN-FIX) — data-driven from the existing Dropshipping Product List; NOT hard-coded.
 * Section A Store Configuration · Section B Live Store Setup Execution · Section C My Product Catalog & Online Store. */
interface DSProduct { product_id: string; name: string; category: string | null; supplier: string | null; approved_selling_price: number; currency: string; image: string | null; availability: number | null; description: string | null; }
interface ShopProduct extends DSProduct { listing_status: string; localized_description: string; }
interface Ev { step: number | string; task: string; agent: string; status: string; duration_ms?: number; result?: any; evidence?: string; }
interface Shop { store_id: string; store_name: string; language: string; currency: string; overall_status: string; store_url: string; logo_asset_id: string; products: ShopProduct[]; execution_events: Ev[]; unresolved_blockers: string[]; integration_status: string; verification_status: string; publication_status: string; order_capture_status: string; }

const COLORS: Record<string, string> = { pending: "#9aa3b8", executing: "#3b82f6", completed: "#22c55e", verified: "#22c55e", reused: "#22c55e", pending_integration: "#e0a23a", recovering: "#e0a23a", blocked: "#e0655f", failed: "#e0655f", quarantined: "#8b5cf6" };

export function MyShopView() {
  const [shop, setShop] = useState<Shop | null>(null);
  const [master, setMaster] = useState<DSProduct[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("AIVORA Coffee");
  const [language, setLanguage] = useState("English");
  const [q, setQ] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sec, setSec] = useState<string | null>(null);

  async function loadShop() { try { const j = await (await fetch(`/api/odai/shop?_t=${Date.now()}`)).json(); if (j && !j.error) setShop(j); } catch {} }
  async function loadMaster() { try { const j = await (await fetch(`/api/odai/shop/products?_t=${Date.now()}`)).json(); setMaster(j.products || []); setPicked(new Set((j.products || []).map((p: DSProduct) => p.product_id))); } catch {} }
  useEffect(() => { void loadShop(); void loadMaster(); }, []);

  async function prepare() { setBusy(true);
    try { const j = await (await fetch(`/api/odai/shop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, language, currency: "SGD", product_ids: [...picked] }) })).json(); if (j.store_id) setShop(j); } finally { setBusy(false); } }
  async function addSel() { setBusy(true); try { const j = await (await fetch(`/api/odai/shop/add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_ids: [...picked] }) })).json(); if (j.store_id) setShop(j); setShowPicker(false); } finally { setBusy(false); } }
  async function remove(id: string) { const j = await (await fetch(`/api/odai/shop/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_id: id }) })).json(); if (j.store_id) { setShop(j); setSec("Removed from this shop only — master product preserved."); } }
  async function priceTest() { if (!shop) return; const t = shop.products.find((p) => /tongkat/i.test(p.name)) || shop.products[0]; const j = await (await fetch(`/api/odai/shop/price-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "mkt-untrusted", product_id: t.product_id, new_price: 15, approved: false }) })).json(); setSec(j.blocked ? `🛡 RogueAI BLOCKED ${t.name} → SGD ${j.incident.attempted}; preserved approved SGD ${j.preserved_price}; agent quarantined.` : `Allowed: SGD ${j.price}`); await loadShop(); }

  const filtered = master.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const done = shop ? shop.execution_events.filter((e) => ["completed", "verified", "reused"].includes(e.status)).length : 0;
  const total = shop ? shop.execution_events.length : 0;

  return (
    <div style={{ padding: 16, maxWidth: 520, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* SECTION A */}
      <section style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Store Configuration</h3>
        <label style={{ fontSize: 12, color: "#5b6472" }}>Store name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "9px 10px", borderRadius: 10, border: "1px solid #d7dbe3", margin: "4px 0 10px", fontSize: 14 }} />
        <label style={{ fontSize: 12, color: "#5b6472" }}>Store language</label>
        <div style={{ display: "flex", gap: 16, margin: "4px 0 10px" }}>
          {["English", "Chinese"].map((L) => (<label key={L} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><input type="radio" checked={language === L} onChange={() => setLanguage(L)} />{L}</label>))}
        </div>
        <div style={{ fontSize: 12, color: "#5b6472", marginBottom: 10 }}>Currency: <b>SGD — Singapore Dollar</b></div>
        <button onClick={() => void prepare()} disabled={busy || picked.size === 0} style={{ width: "100%", padding: "12px", borderRadius: 12, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>🛒 Prepare Store Setup</button>
        <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 6 }}>{picked.size} of {master.length} dropshipping products selected</div>
      </section>

      {/* SECTION B */}
      {shop && (
        <section style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Store Setup Execution <span style={{ fontSize: 12, color: "#0e6b57", float: "right" }}>{done} of {total} steps</span></h3>
          {shop.execution_events.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: i ? "1px solid #eef0f4" : "none" }}>
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: COLORS[e.status] || "#9aa3b8", flex: "0 0 auto", marginTop: 2 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{String(e.step).padStart(2, "0")} · {e.task}</div>
                <div style={{ fontSize: 11, color: "#8a93a3" }}>{e.agent} · <span style={{ color: COLORS[e.status] || "#8a93a3", fontWeight: 700 }}>{e.status}</span>{e.duration_ms != null ? ` · ${e.duration_ms}ms` : ""}</div>
                {e.evidence && <div style={{ fontSize: 11, color: "#5b6472" }}>{e.evidence}</div>}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* SECTION C */}
      {shop && (
        <section style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>My Product Catalog & Online Store</h3>
          {shop.products.map((p) => (
            <div key={p.product_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid #eef0f4" }}>
              {p.image ? <img src={p.image} alt={p.name} style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} /> : <div style={{ width: 44, height: 44, borderRadius: 8, background: "#eef0f4" }} />}
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div><div style={{ fontSize: 11, color: "#8a93a3" }}>{p.category || ""}{p.supplier ? ` · ${p.supplier}` : ""} · {p.listing_status}</div></div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#0e6b57" }}>{p.currency} {p.approved_selling_price.toFixed(2)}</div>
              <button onClick={() => void remove(p.product_id)} style={{ border: "1px solid #e0655f", color: "#e0655f", background: "#fff", borderRadius: 8, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}>Remove</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button onClick={() => setShowPicker((s) => !s)} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #0e6b57", background: "#fff", color: "#0e6b57", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Add Products</button>
            <a href={shop.store_url} target="_blank" rel="noopener" style={{ padding: "8px 12px", borderRadius: 10, background: "#0e6b57", color: "#fff", fontWeight: 700, fontSize: 12, textDecoration: "none" }}>Open My Online Shop</a>
            <button onClick={() => { void navigator.clipboard?.writeText(shop.store_url); setSec("Store link copied."); }} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #d7dbe3", background: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Copy Store Link</button>
            <button onClick={() => void priceTest()} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #8b5cf6", background: "#fff", color: "#8b5cf6", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>RogueAI price test</button>
          </div>
          <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 8 }}>Sync: <b style={{ color: "#e0a23a" }}>{shop.integration_status}</b> · Verification: <b style={{ color: "#e0a23a" }}>{shop.verification_status}</b> · Publication: <b>{shop.publication_status}</b> · Orders: <b>{shop.order_capture_status}</b></div>
          {shop.unresolved_blockers.length > 0 && <div style={{ marginTop: 6 }}>{shop.unresolved_blockers.map((b, i) => <div key={i} style={{ fontSize: 11, color: "#e0a23a" }}>• {b}</div>)}</div>}
          {sec && <div style={{ fontSize: 12, color: "#0e6b57", marginTop: 8 }}>{sec}</div>}

          {showPicker && (
            <div style={{ marginTop: 12, border: "1px solid #eef0f4", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #d7dbe3", fontSize: 13 }} />
                <button onClick={() => setPicked(new Set(master.map((m) => m.product_id)))} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d7dbe3", fontSize: 12 }}>Select All</button>
                <button onClick={() => setPicked(new Set())} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d7dbe3", fontSize: 12 }}>Deselect All</button>
              </div>
              {filtered.map((p) => (
                <label key={p.product_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: "1px solid #f4f6f9", fontSize: 13 }}>
                  <input type="checkbox" checked={picked.has(p.product_id)} onChange={() => setPicked((s) => { const n = new Set(s); n.has(p.product_id) ? n.delete(p.product_id) : n.add(p.product_id); return n; })} />
                  {p.image && <img src={p.image} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover" }} />}
                  <span style={{ flex: 1 }}>{p.name}</span><span style={{ color: "#0e6b57", fontWeight: 700 }}>{p.currency} {p.approved_selling_price.toFixed(2)}</span>
                </label>
              ))}
              <button onClick={() => void addSel()} disabled={busy} style={{ width: "100%", marginTop: 10, padding: "10px", borderRadius: 10, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, cursor: "pointer" }}>Add Selected Products to My Shop</button>
            </div>
          )}
        </section>
      )}
      {!shop && <div style={{ fontSize: 12, color: "#8a93a3", textAlign: "center" }}>Set your store details and press <b>Prepare Store Setup</b> to run the live setup.</div>}
    </div>
  );
}
