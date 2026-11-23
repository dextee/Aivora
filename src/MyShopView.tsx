import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/* My Shop (MAIN-FIX) — V43 high-speed animated store-creation experience.
 * Data-driven from the existing Dropshipping Product List; the console streams ACTUAL persisted
 * execution events (no fabricated backend success). External Hashmeta sync/verification stay
 * pending/partial. ENTER THE STORE opens the exact approved storefront URL. */
interface DSProduct { product_id: string; name: string; category: string | null; supplier: string | null; approved_selling_price: number; currency: string; image: string | null; availability: number | null; description: string | null; }
interface ShopProduct extends DSProduct { listing_status: string; localized_description: string; }
interface CEvent { id: number; phase: string; line: string; agent: string; status: string; ts: string; duration_ms: number; evidence: string | null; weight: number; }
interface Ev { step: number | string; task: string; agent: string; status: string; duration_ms?: number; result?: any; evidence?: string; }
interface Shop { store_id: string; store_name: string; language: string; currency: string; marketing_message: string; overall_status: string; store_url: string; logo_asset_id: string; progress: number; product_count: number; products: ShopProduct[]; execution_events: Ev[]; console_events: CEvent[]; unresolved_blockers: string[]; integration_status: string; verification_status: string; publication_status: string; order_capture_status: string; }

const COLORS: Record<string, string> = { pending: "#9aa3b8", running: "#3b82f6", completed: "#34e0a1", verified: "#34e0a1", reused: "#34e0a1", pending_integration: "#e0a23a", recovering: "#e0a23a", partial: "#e0a23a", blocked: "#ff6b6b", failed: "#ff6b6b", quarantined: "#b07cff" };
const ICON: Record<string, string> = { completed: "✓", verified: "✓", reused: "↻", pending: "…", running: "▶", recovering: "↻", partial: "~", pending_integration: "…", blocked: "✕", failed: "✕", quarantined: "⊘" };
const PHASE_LABEL: Record<string, string> = { objective: "OBJECTIVE", agents: "AGENTS", catalog: "CATALOG", brand: "BRAND", pricing: "PRICING", assets: "ASSETS", security: "SECURITY", storefront: "STOREFRONT", healing: "HEALING", completion: "COMPLETION" };

const STORE_DESTINATION = "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/zh/coffee-store";
const localSetupVerified = (s: Shop) => [1, 2, 3, 4, 6, 7, 8, 9, 10, 12].every(step => s.execution_events.some(e => e.step === step && ["completed", "verified", "reused"].includes(e.status)));

const prefersReduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function MyShopView() {
  const [shop, setShop] = useState<Shop | null>(null);
  const [master, setMaster] = useState<DSProduct[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("AIVORA Coffee");
  const [language, setLanguage] = useState("English");
  const [marketing, setMarketing] = useState("Great Premium Coffee Every Morning");
  const [q, setQ] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sec, setSec] = useState<string | null>(null);

  // animation console state
  const [revealed, setRevealed] = useState(0);
  const [running, setRunning] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);
  const [showCompletion, setShowCompletion] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [qr, setQr] = useState<{ url: string; data_url: string } | null>(null);
  const [paypal, setPaypal] = useState("https://paypal.me/AntimosSG?locale.x=en_GB&COUNTY.X=SG");
  const [payments, setPayments] = useState<{ payments: any[]; incidents: any[]; revenue: any } | null>(null);
  const [payMsg, setPayMsg] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  async function loadShop() { try { const j = await (await fetch(`/api/odai/shop?_t=${Date.now()}`)).json(); if (j && !j.error) { setShop(j); setRevealed((j.console_events || []).length); } } catch {} }
  async function loadMaster() { try { const j = await (await fetch(`/api/odai/shop/products?_t=${Date.now()}`)).json(); setMaster(j.products || []); setPicked(new Set((j.products || []).map((p: DSProduct) => p.product_id))); } catch {} }
  async function loadConfig() { try { const j = await (await fetch(`/api/odai/shop/config?_t=${Date.now()}`)).json(); if (j.paypal_url) setPaypal(j.paypal_url); } catch {} }
  async function loadPayments() { try { setPayments(await (await fetch(`/api/odai/shop/payments?_t=${Date.now()}`)).json()); } catch {} }
  useEffect(() => { void loadShop(); void loadMaster(); void loadConfig(); void loadPayments(); }, []);

  const events = shop?.console_events || [];
  const total = events.length;

  // burst render loop: reveal actual queued events at ~40-70ms/line (faster during large bursts)
  useEffect(() => {
    if (!running) return;
    if (prefersReduced()) { setRevealed(total); setRunning(false); setShowCompletion(true); return; }
    const t = setInterval(() => {
      setRevealed((r) => {
        const remaining = total - r;
        if (remaining <= 0) { clearInterval(t); setRunning(false); setShowCompletion(true); return r; }
        const burst = remaining > 18 ? 5 : remaining > 8 ? 3 : 2; // 15-25 lines/sec during bursts
        return Math.min(total, r + burst);
      });
    }, 50);
    return () => clearInterval(t);
  }, [running, total]);

  useEffect(() => { const el = bodyRef.current; if (el && !prefersReduced()) el.scrollTop = el.scrollHeight; }, [revealed]);

  async function prepare() {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    setShowTerminal(true); setShowProducts(false); setBusy(true); setShowCompletion(false); setRevealed(0); setExpanded(new Set());
    try {
      const j = await (await fetch(`/api/odai/shop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, language, currency: "SGD", marketing_message: marketing, product_ids: [...picked] }) })).json();
      if (j.store_id) { setShop(j); setRunning(true); revealTimer.current = setTimeout(() => setShowProducts(true), 1000); }
    } finally { setBusy(false); }
  }
  async function addSel() { setBusy(true); try { const j = await (await fetch(`/api/odai/shop/add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_ids: [...picked] }) })).json(); if (j.store_id) setShop(j); setShowPicker(false); } finally { setBusy(false); } }
  async function remove(id: string) { const j = await (await fetch(`/api/odai/shop/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_id: id }) })).json(); if (j.store_id) { setShop(j); setSec("Removed from this shop only — master product preserved."); } }
  async function priceTest() { if (!shop) return; const t = shop.products.find((p) => /tongkat/i.test(p.name)) || shop.products[0]; const j = await (await fetch(`/api/odai/shop/price-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "mkt-untrusted", product_id: t.product_id, new_price: 15, approved: false }) })).json(); setSec(j.blocked ? `🛡 RogueAI BLOCKED ${t.name} → SGD ${j.incident.attempted}; preserved approved SGD ${j.preserved_price}; agent quarantined.` : `Allowed: SGD ${j.price}`); await loadShop(); }
  async function genQr() { if (qr) { setQr(null); return; } try { const j = await (await fetch(`/api/odai/shop/qr`)).json(); setQr({ url: j.url, data_url: j.data_url }); } catch { setSec("QR generation unavailable."); } }
  async function buyNow(p: ShopProduct) {
    /* record the link open (NOT proof of payment), then open the approved PayPal URL */
    try { await fetch(`/api/odai/shop/payment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_id: p.product_id, action: "open_link" }) }); } catch {}
    window.open(paypal, "_blank", "noopener,noreferrer");
    setPayMsg(`BUY NOW opened PayPal for ${p.name}. Status: PAYMENT_PENDING — opening the link is not proof of payment.`);
    await loadPayments();
  }
  async function paymentGuardTest() {
    const j = await (await fetch(`/api/odai/shop/payment-guard-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "mkt-untrusted", proposed_url: "https://paypal.me/evil-attacker" }) })).json();
    setPayMsg(j.blocked ? `🛡 RogueAI BLOCKED payment-destination change; approved PayPal preserved; incident ${j.incident.incident_id} recorded.` : "No change attempted.");
    await loadPayments();
  }

  // weighted progress climbs with actually-revealed events, capped at the engine's real progress
  const pct = total ? Math.round((revealed / total) * (shop?.progress ?? 100)) : 0;
  const donePhases = useMemo(() => { const s = new Set<string>(); for (let i = 0; i < revealed; i++) s.add(events[i]?.phase); return s; }, [revealed, events]);
  const phaseDone = (p: string) => { const last = events.reduce((a, e) => (e.phase === p ? e.id : a), 0); return revealed >= last && last > 0; };
  const filtered = master.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ padding: 16, paddingBottom: 100, maxWidth: 560, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{`
        @keyframes avBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
        @keyframes avSpin { to{transform:rotate(360deg)} }
        @keyframes avFadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        @keyframes avPop { 0%{transform:scale(.4);opacity:0} 70%{transform:scale(1.12)} 100%{transform:scale(1);opacity:1} }
        @keyframes avShimmer { 0%{background-position:-120px 0} 100%{background-position:160px 0} }
        .av-line{animation:avFadeUp .18s ease-out}
        .av-stage{animation:avFadeUp .3s ease-out}
        .av-check{animation:avPop .5s ease-out}
        @media (prefers-reduced-motion: reduce){ .av-line,.av-stage,.av-check{animation:none!important} }
      `}</style>

      {/* SECTION A — Store Configuration */}
      <section style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Store Configuration</h3>
        <label style={{ fontSize: 12, color: "#5b6472" }}>Store name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "9px 10px", borderRadius: 10, border: "1px solid #d7dbe3", margin: "4px 0 10px", fontSize: 14 }} />
        <label style={{ fontSize: 12, color: "#5b6472" }}>Store language</label>
        <div style={{ display: "flex", gap: 16, margin: "4px 0 10px" }}>
          {["English", "Chinese"].map((L) => (<label key={L} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><input type="radio" checked={language === L} onChange={() => setLanguage(L)} />{L}</label>))}
        </div>
        <label style={{ fontSize: 12, color: "#5b6472" }}>Marketing message</label>
        <input value={marketing} onChange={(e) => setMarketing(e.target.value)} style={{ width: "100%", padding: "9px 10px", borderRadius: 10, border: "1px solid #d7dbe3", margin: "4px 0 10px", fontSize: 14 }} />
        <div style={{ fontSize: 12, color: "#5b6472", marginBottom: 10 }}>Currency: <b>SGD — Singapore Dollar</b></div>
        <button onClick={() => void prepare()} disabled={busy || picked.size === 0} style={{ width: "100%", padding: "12px", borderRadius: 12, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>🛒 Prepare Store Setup</button>
        <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 6 }}>{picked.size} of {master.length} dropshipping products selected</div>
      </section>

      {/* Show execution only after the user explicitly prepares this setup. */}
      {showTerminal && (
        <section className="av-check" style={{ background: "#08312b", borderRadius: 16, padding: 0, overflow: "hidden", boxShadow: "0 4px 16px rgba(8,49,43,.35)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#0b3b33", color: "#cfeee6", fontSize: 12, fontWeight: 700 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {running && <span style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid #34e0a1", borderTopColor: "transparent", display: "inline-block", animation: "avSpin .8s linear infinite" }} />}
              AIVORA · STORE CREATION TERMINAL
            </span>
            <span style={{ color: "#34e0a1", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>{pct}%</span>
          </div>
          {/* weighted progress bar (climbs with real events) */}
          <div style={{ height: 4, background: "#06302a" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#1fb886,#34e0a1)", transition: "width .12s linear", backgroundImage: "linear-gradient(90deg,#1fb886,#34e0a1,#1fb886)", backgroundSize: "120px 100%", animation: running ? "avShimmer 1s linear infinite" : "none" }} />
          </div>
          <div ref={bodyRef} style={{ maxHeight: 150, overflowY: "auto", padding: "10px 14px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.55 }}>
            {events.slice(0, revealed).map((e) => (
              <div key={e.id} className="av-line">
                <div style={{ display: "flex", gap: 6, alignItems: "baseline", cursor: e.evidence ? "pointer" : "default" }}
                  onClick={() => { if (!e.evidence) return; setExpanded((s) => { const n = new Set(s); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; }); }}>
                  <span style={{ color: COLORS[e.status] || "#9aa3b8", fontWeight: 800 }}>{ICON[e.status] || "•"}</span>
                  <span style={{ color: "#5f7d76" }}>{e.ts.slice(11, 23)}</span>
                  <span style={{ color: "#7fb0a6" }}>{PHASE_LABEL[e.phase] || e.phase}</span>
                  <span style={{ color: COLORS[e.status] === "#34e0a1" ? "#34e0a1" : "#cfeee6" }}>{e.line}</span>
                  <span style={{ color: "#5f7d76", marginLeft: "auto" }}>{e.agent}</span>
                </div>
                {e.evidence && expanded.has(e.id) && <div style={{ color: "#8fb0a8", padding: "2px 0 4px 22px" }}>↳ {e.evidence}</div>}
              </div>
            ))}
            {running && <div style={{ color: "#34e0a1" }}>▋<span style={{ animation: "avBlink 1s step-end infinite" }}>_</span></div>}
          </div>
        </section>
      )}

      {/* SECTION — Progressive visual output (7 stages, reveal as real artifacts become available) */}
      {shop && showProducts && (
        <section style={{ background: "#fff", borderRadius: 16, padding: 14, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Dropshipping Available Products</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {phaseDone("pricing") && <Stage n={4} title="Verified prices">{shop.products.map((p) => <div key={p.product_id} style={{ fontSize: 11 }}><b>{p.name}</b> · {p.currency} {p.approved_selling_price.toFixed(2)}</div>)}</Stage>}
            {phaseDone("assets") && <Stage n={3} title="Product photos"><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{shop.products.map((p) => p.image ? <img key={p.product_id} src={p.image} alt={p.name} onError={(ev) => { (ev.target as HTMLImageElement).style.opacity = ".25"; }} style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} /> : <div key={p.product_id} style={{ width: 36, height: 36, borderRadius: 6, background: "#eef0f4" }} />)}</div></Stage>}
            {phaseDone("catalog") && <Stage n={5} title="Catalog">{shop.product_count} products assembled</Stage>}
            {phaseDone("storefront") && <Stage n={6} title="Storefront link"><a href={STORE_DESTINATION} onClick={(e) => { e.preventDefault(); setStoreOpen(true); }} style={{ fontSize: 11, color: "#0e6b57", wordBreak: "break-all" }}>{shop.store_url}</a></Stage>}
            {phaseDone("completion") && <Stage n={7} title="Readiness"><span style={{ color: "#0e6b57", fontWeight: 800 }}>✓ Ready to enter</span></Stage>}
          </div>
          {shop.integration_status === "linked" && <div style={{ fontSize: 11, color: "#e0a23a", marginTop: 8 }}>External catalog sync: PENDING (no HASHMETA_API_TOKEN) — storefront link is local, not a claim of external publish.</div>}
        </section>
      )}

      {/* COMPLETION SCREEN */}
      {shop && showProducts && showCompletion && localSetupVerified(shop) && (
        <section style={{ background: "#fff", borderRadius: 16, padding: 20, textAlign: "center", boxShadow: "0 4px 16px rgba(14,107,87,.18)", border: "1px solid #d6f0e6" }}>
          <div className="av-check" style={{ width: 72, height: 72, borderRadius: "50%", background: "#0e6b57", color: "#fff", fontSize: 40, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>✓</div>
          <h2 style={{ margin: "0 0 4px", fontSize: 20, color: "#0e6b57" }}>YOUR SHOP IS READY!</h2>
          <div style={{ fontSize: 13, color: "#5b6472", marginBottom: 10 }}>Dropshipping Available Products</div>
          <p style={{ fontSize: 12, color: "#5b6472" }}>Mandatory local setup verified. External synchronization and publication remain subject to their recorded status.</p>
          <div style={{ display: "flex", justifyContent: "center", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
            {shop.products.map((p) => p.image ? <img key={p.product_id} src={p.image} alt={p.name} onError={(ev) => { (ev.target as HTMLImageElement).style.opacity = ".25"; }} style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} /> : null)}
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 14, fontSize: 12, color: "#5b6472", marginBottom: 14 }}>
            <span>Products: <b>{shop.product_count}</b></span><span>Currency: <b>{shop.currency}</b></span><span>Storefront: <b>Hashmeta</b></span>
          </div>
          <a href={STORE_DESTINATION} onClick={(e) => { e.preventDefault(); setStoreOpen(true); }} style={{ display: "block", width: "100%", padding: "14px", borderRadius: 12, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, fontSize: 15, textDecoration: "none", marginBottom: 10 }}>ENTER THE STORE →</a>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={() => { void navigator.clipboard?.writeText(STORE_DESTINATION); setSec("Store link copied."); }} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #d7dbe3", background: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Copy Store Link</button>
            <button onClick={() => setShowHistory((s) => !s)} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #d7dbe3", background: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>View Execution History</button>
            <button onClick={() => void genQr()} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #0e6b57", background: "#fff", color: "#0e6b57", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{qr ? "Hide QR" : "Generate Store QR Code"}</button>
          </div>
          {qr && (
            <div style={{ marginTop: 14, padding: 12, border: "1px solid #eef0f4", borderRadius: 12 }}>
              <img src={qr.data_url} alt="store QR" style={{ width: 160, height: 160 }} />
              <div style={{ fontSize: 11, color: "#8a93a3", wordBreak: "break-all", marginTop: 6 }}>{qr.url}</div>
            </div>
          )}
          {showHistory && (
            <div style={{ marginTop: 12, textAlign: "left", border: "1px solid #eef0f4", borderRadius: 12, padding: 10, maxHeight: 220, overflowY: "auto" }}>
              {shop.execution_events.map((e, i) => (<div key={i} style={{ fontSize: 11, padding: "3px 0", borderTop: i ? "1px solid #f4f6f9" : "none" }}><b>{String(e.step).padStart(2, "0")}</b> · {e.task} <span style={{ color: "#8a93a3" }}>({e.agent}) — {e.status}</span></div>))}
            </div>
          )}
          {sec && <div style={{ fontSize: 12, color: "#0e6b57", marginTop: 10 }}>{sec}</div>}
        </section>
      )}

      {/* SECTION C — Catalog management (after build) */}
      {shop && showProducts && !showCompletion && (
        <section style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>My Product Catalog & Online Store</h3>
          {shop.products.map((p) => (
            <div key={p.product_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid #eef0f4" }}>
              {p.image ? <img src={p.image} alt={p.name} style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} /> : <div style={{ width: 44, height: 44, borderRadius: 8, background: "#eef0f4" }} />}
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div><div style={{ fontSize: 11, color: "#8a93a3" }}>{p.category || ""}{p.supplier ? ` · ${p.supplier}` : ""} · {p.listing_status}</div></div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#0e6b57" }}>{p.currency} {p.approved_selling_price.toFixed(2)}</div>
              <button onClick={() => void buyNow(p)} title="Buy now with PayPal" style={{ border: 0, background: "#0e6b57", color: "#fff", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>🛒 BUY NOW</button>
              <button onClick={() => void remove(p.product_id)} style={{ border: "1px solid #e0655f", color: "#e0655f", background: "#fff", borderRadius: 8, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}>Remove</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button onClick={() => setShowPicker((s) => !s)} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #0e6b57", background: "#fff", color: "#0e6b57", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Add Products</button>
            <a href={STORE_DESTINATION} onClick={(e) => { e.preventDefault(); setStoreOpen(true); }} style={{ padding: "8px 12px", borderRadius: 10, background: "#0e6b57", color: "#fff", fontWeight: 700, fontSize: 12, textDecoration: "none" }}>Open My Online Shop</a>
            <button onClick={() => void priceTest()} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #8b5cf6", background: "#fff", color: "#8b5cf6", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>RogueAI price test</button>
          </div>
          {shop.unresolved_blockers.length > 0 && <div style={{ marginTop: 8 }}>{shop.unresolved_blockers.map((b, i) => <div key={i} style={{ fontSize: 11, color: "#e0a23a" }}>• {b}</div>)}</div>}
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
                  <input type="checkbox" checked={picked.has(p.product_id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.product_id)) n.delete(p.product_id); else n.add(p.product_id); return n; })} />
                  {p.image && <img src={p.image} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover" }} />}
                  <span style={{ flex: 1 }}>{p.name}</span><span style={{ color: "#0e6b57", fontWeight: 700 }}>{p.currency} {p.approved_selling_price.toFixed(2)}</span>
                </label>
              ))}
              <button onClick={() => void addSel()} disabled={busy} style={{ width: "100%", marginTop: 10, padding: "10px", borderRadius: 10, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, cursor: "pointer" }}>Add Selected Products to My Shop</button>
            </div>
          )}
        </section>
      )}
      {shop && showProducts && (
        <section style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>PayPal Payments</h3>
          <div style={{ fontSize: 11, color: "#8a93a3", marginBottom: 8 }}>Approved destination (protected): <span style={{ wordBreak: "break-all" }}>{paypal}</span></div>
          <button onClick={() => void paymentGuardTest()} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #8b5cf6", background: "#fff", color: "#8b5cf6", fontWeight: 700, fontSize: 12, cursor: "pointer", marginBottom: 10 }}>🛡 RogueAI payment-guard test</button>
          {payments && payments.payments.length > 0 ? payments.payments.map((p) => (
            <div key={p.payment_id} style={{ fontSize: 12, padding: "5px 0", borderTop: "1px solid #eef0f4" }}>
              <b>{p.product_id}</b> · <span style={{ color: p.status === "PAYMENT_VERIFIED" ? "#0e6b57" : p.status === "PAYMENT_FAILED" ? "#e0655f" : "#e0a23a", fontWeight: 700 }}>{p.status}</span>{p.verified ? " ✓ verified" : " · not verified"}
            </div>
          )) : <div style={{ fontSize: 12, color: "#8a93a3" }}>No payment events yet. Click BUY NOW to open PayPal (recorded as PAYMENT_PENDING, not paid).</div>}
          {payments && <div style={{ fontSize: 12, marginTop: 8 }}>Collected revenue (verified only): <b>{payments.revenue.currency} {payments.revenue.collected_revenue.toFixed(2)}</b> · pending: {payments.revenue.pending_count}</div>}
          {payments && payments.incidents.length > 0 && <div style={{ fontSize: 11, color: "#b03a2e", marginTop: 6 }}>🛡 {payments.incidents.length} payment-protection incident(s) recorded.</div>}
          {payMsg && <div style={{ fontSize: 12, color: "#0e6b57", marginTop: 8 }}>{payMsg}</div>}
        </section>
      )}
      {showProducts && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30, padding: "12px 16px calc(12px + env(safe-area-inset-bottom))", background: "var(--bg, #eeeade)", borderTop: "1px solid var(--line, #d7dbe3)" }}>
        <a href={STORE_DESTINATION} onClick={(e) => { e.preventDefault(); setStoreOpen(true); }} style={{ display: "block", maxWidth: 528, margin: "0 auto", padding: 14, borderRadius: 12, background: "var(--green, #0e6b57)", color: "var(--white, #fff)", textAlign: "center", fontWeight: 800, textDecoration: "none" }}>ENTER THE STORE →</a>
      </div>}
      {storeOpen && <section role="dialog" aria-modal="true" aria-label="Coffee storefront" style={{ position: "fixed", inset: 0, zIndex: 100, background: "var(--bg, #eeeade)", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: "var(--green, #0e6b57)", color: "white" }}>
          <button autoFocus onClick={() => setStoreOpen(false)} style={{ padding: "10px 14px", borderRadius: 8, border: 0 }}>← Back to My Shop</button>
          <strong style={{ flex: 1 }}>Coffee Store</strong>
          <a href={STORE_DESTINATION} target="_blank" rel="noopener noreferrer" style={{ color: "white" }}>Open externally</a>
        </header>
        <p style={{ margin: 0, padding: "8px 12px", fontSize: 12 }}>If the store cannot be embedded, use Open externally. Your My Shop setup remains saved when you return.</p>
        <iframe title="Hashmeta Coffee Store" src={STORE_DESTINATION} referrerPolicy="strict-origin-when-cross-origin" style={{ flex: 1, width: "100%", border: 0 }} />
      </section>}
      {!shop && <div style={{ fontSize: 12, color: "#8a93a3", textAlign: "center" }}>Set your store details and press <b>Prepare Store Setup</b> to watch the live build.</div>}
    </div>
  );
}

function Stage({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="av-stage" style={{ border: "1px solid #eef0f4", borderRadius: 12, padding: 10 }}>
      <div style={{ fontSize: 10, color: "#8a93a3", fontWeight: 800, marginBottom: 4 }}>STAGE {n} · {title}</div>
      <div style={{ fontSize: 12 }}>{children}</div>
    </div>
  );
}
