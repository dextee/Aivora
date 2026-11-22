import { useEffect, useState } from "react";

/* My Shop — SETUP_ONLINE_SHOP with a LIVE execution line (reuses existing backend; no fake timers).
 * Honest: external sync/verification shown as PENDING/PARTIAL; publication stays draft. */
interface Ev { step: number | string; task: string; agent: string; skill: string; status: string; start: string; end?: string; duration_ms?: number; result?: any; evidence?: string; retry?: number; error?: string; }
interface Prod { id: string; name: string; price: number; currency: string; image: string; }
interface Shop { store_id: string; store_name: string; language: string; currency: string; overall_status: string; store_url: string; logo_asset_id: string; products: Prod[]; execution_events: Ev[]; unresolved_blockers: string[]; }

const COLORS: Record<string, string> = { pending: "#6b7280", executing: "#3b82f6", completed: "#22c55e", verified: "#22c55e", reused: "#22c55e", pending_integration: "#e0a23a", blocked: "#e0655f", failed: "#e0655f", quarantined: "#8b5cf6" };

export function MyShopView() {
  const [shop, setShop] = useState<Shop | null>(null);
  const [busy, setBusy] = useState(false);
  const [sec, setSec] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<number | string | null>(null);

  async function load() { try { const j = await (await fetch(`/api/odai/shop?_t=${Date.now()}`)).json(); if (j && !j.error) setShop(j); } catch { /* none yet */ } }
  useEffect(() => { void load(); }, []);

  async function start() { setBusy(true);
    try { const j = await (await fetch(`/api/odai/submit?_t=${Date.now()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Help me set up my online coffee shop.", request_id: `shop:${Date.now()}`, source: "typed" }) })).json(); if (j.store_id) setShop(j); } finally { setBusy(false); } }

  async function priceTest() { if (!shop) return; setBusy(true);
    const tongkat = shop.products.find((p) => /tongkat/i.test(p.name)) || shop.products[0];
    try { const j = await (await fetch(`/api/odai/shop/price-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "mkt-untrusted", product_id: tongkat.id, new_price: 15, approved: false }) })).json();
      setSec(j.blocked ? `🛡 RogueAI Shield BLOCKED the change to SGD ${j.incident.attempted} — preserved approved SGD ${j.preserved_price_sgd}; agent quarantined; ${j.resume}.` : `Allowed: SGD ${j.price_sgd}`);
      await load(); } finally { setBusy(false); } }

  const done = shop ? shop.execution_events.filter((e) => ["completed", "verified", "reused"].includes(e.status)).length : 0;
  const total = shop ? shop.execution_events.length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  if (!shop) return (
    <div className="view" style={{ padding: 22, maxWidth: 900, margin: "0 auto" }}>
      <h2>🛍 My Shop</h2>
      <p style={{ color: "var(--ink2)" }}>Set up the AIVORA Coffee online shop and watch the AI agents work in a live execution line.</p>
      <button className="q4send" style={{ padding: "10px 18px" }} onClick={() => void start()} disabled={busy}>{busy ? "Setting up…" : "Start shop setup"}</button>
    </div>
  );

  return (
    <div className="view" style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      {/* HEADER */}
      <section style={{ border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: "12px 16px", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
        <div><b style={{ fontSize: 18 }}>AIVORA — MY SHOP</b><div style={{ fontSize: 12, color: "var(--ink2)" }}>{shop.store_name} · {shop.language} · {shop.currency} · <span style={{ color: "#3fb37f" }}>{shop.overall_status}</span></div></div>
        <div style={{ minWidth: 200 }}><div style={{ fontSize: 11, color: "var(--ink2)" }}>Overall execution {pct}%</div><div style={{ height: 8, background: "rgba(255,255,255,.08)", borderRadius: 6, overflow: "hidden" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#0e6b6b,#3fb37f)" }} /></div></div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* LEFT — LIVE EXECUTION LINE */}
        <section style={{ border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 12 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>🧭 Live execution line</h3>
          {shop.execution_events.map((e) => (
            <div key={String(e.step) + e.task} style={{ borderLeft: `4px solid ${COLORS[e.status] || "#6b7280"}`, padding: "6px 8px", marginBottom: 6, background: "rgba(255,255,255,.03)", borderRadius: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b style={{ fontSize: 12.5 }}>{String(e.step).padStart(2, "0")} · {e.task}</b>
                <span style={{ fontSize: 11, color: COLORS[e.status] || "#6b7280", fontWeight: 700 }}>{e.status}{e.duration_ms != null ? ` · ${e.duration_ms}ms` : ""}{e.retry ? ` · retry ${e.retry}` : ""}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink2)" }}>{e.agent} · skill {e.skill}</div>
              <button className="net-test" style={{ marginTop: 4, padding: "2px 8px", fontSize: 10 }} onClick={() => setOpenStep(openStep === e.step ? null : e.step)}>details</button>
              {openStep === e.step && <pre style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: "6px 0 0", color: "var(--ink2)" }}>{JSON.stringify({ result: e.result, evidence: e.evidence, error: e.error }, null, 2)}</pre>}
            </div>
          ))}
        </section>

        {/* RIGHT — LIVE BUSINESS OUTPUT */}
        <section style={{ border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 12 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>📦 Live business output</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}><img src={shop.logo_asset_id} alt="logo" style={{ width: 40, height: 40, borderRadius: 10 }} /><span style={{ fontSize: 12, color: "var(--ink2)" }}>Logo: existing brand asset reused (not fabricated)</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 8 }}>
            {shop.products.map((p) => (
              <div key={p.id} style={{ border: "1px solid var(--line,#2a2f45)", borderRadius: 10, overflow: "hidden" }}>
                <img src={p.image} alt={p.name} loading="lazy" style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover" }} />
                <div style={{ padding: 6, fontSize: 11 }}><b>{p.name}</b><div style={{ color: "#3fb37f", fontWeight: 700 }}>{p.currency} {p.price.toFixed(2)}</div></div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 12 }}>🌐 Storefront: <a href={shop.store_url} target="_blank" rel="noopener" style={{ color: "#3fb37f" }}>{shop.store_url}</a></div>
          {shop.unresolved_blockers.length > 0 && <div style={{ marginTop: 8 }}><b style={{ fontSize: 12, color: "#e0a23a" }}>Outstanding:</b>{shop.unresolved_blockers.map((b, i) => <p key={i} style={{ fontSize: 11, color: "var(--ink2)", margin: "2px 0" }}>• {b}</p>)}</div>}
        </section>
      </div>

      {/* BOTTOM — BUSINESS OPERATIONS */}
      <section style={{ border: "1px solid var(--line,#2a2f45)", borderRadius: 14, padding: 12, marginTop: 12 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>⚙️ Business operations</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="q4send" style={{ padding: "7px 12px", textDecoration: "none" }} href={shop.store_url} target="_blank" rel="noopener">View Online Shop</a>
          <button className="q4send" style={{ padding: "7px 12px" }} onClick={() => { void navigator.clipboard?.writeText(shop.store_url); setSec("Store link copied."); }}>Copy Store Link</button>
          <a className="q4send" style={{ padding: "7px 12px", opacity: .85, textDecoration: "none" }} href={shop.store_url} target="_blank" rel="noopener">View Product Catalog</a>
          <button className="q4send" style={{ padding: "7px 12px", background: "#8b5cf6" }} onClick={() => void priceTest()} disabled={busy}>Run RogueAI price-manipulation test</button>
        </div>
        {sec && <p style={{ fontSize: 12, marginTop: 8, color: "#3fb37f" }}>{sec}</p>}
        <p style={{ fontSize: 11, color: "var(--ink2)", marginTop: 8 }}>Publication stays a draft lock; external catalog sync + live browser verification are PENDING/PARTIAL (no HASHMETA_API_TOKEN here) — not marked as passed.</p>
      </section>
    </div>
  );
}
