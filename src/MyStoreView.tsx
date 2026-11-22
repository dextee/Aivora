import { useEffect, useState } from "react";
import { authHeader } from "./lib";

/* My Store — the guided "create an online store" flow + the store record.
 * The interview (name → language → confirm) and every follow-up go through the SAME unified
 * /submit entry, preserving one objective id. The store dashboard shows the real Hashmeta page
 * link, the generated catalog (reused images, owner prices), and the honest sync/publication status. */
interface Product { id: string; name: string; category: string; image: string; description: string; price: number; currency: string; availability: null; benefits: null; specifications: null; action: { type: string; url: string }; }
interface Sync { status: string; basis: string; runtime_auto_sync: string; published: boolean; evidence: { page_id: number; products_on_page: number; verified_at: string }; }
interface StoreRecord {
  objective_id: string; objective_type: string; store_name: string; language: string; integration: string;
  catalog_status: string; product_count: number; last_sync: string; public_url: string; admin_cms_url: string;
  published: boolean; sync: Sync; catalog: Product[]; tasks: string[]; open_label: string;
}
interface Step { objective_id?: string; step?: string; prompt?: string; error?: string; deduped?: boolean; }

const STORE_EVENT_KINDS = ["STORE_NAME_CAPTURED", "LANGUAGE_SELECTED", "PRODUCT_DATABASE_LOADED", "CATALOG_GENERATED", "CATALOG_VALIDATED", "STORE_PAGE_LINKED", "CATALOG_SYNC_VERIFIED", "MY_STORE_UPDATED", "OBJECTIVE_STATUS_UPDATED"];

export function MyStoreView() {
  const [rec, setRec] = useState<StoreRecord | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<{ kind: string; note: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadStore() {
    try { const j = await (await fetch(`/api/odai/store?_t=${Date.now()}`)).json(); if (j && !j.error) setRec(j); } catch { /* none yet */ }
  }
  async function loadLog() {
    try {
      const v = await (await fetch(`/api/odai/view?mode=management&_t=${Date.now()}`)).json();
      const tr = (v.trace || []).filter((e: any) => STORE_EVENT_KINDS.includes(e.kind)).slice(-14);
      setLog(tr.map((e: any) => ({ kind: e.kind, note: e.note })));
    } catch { /* mgmt unavailable */ }
  }
  useEffect(() => { void loadStore(); void loadLog(); }, []);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const j = await (await fetch(`/api/odai/submit?_t=${Date.now()}`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ text, request_id: `store:${Date.now()}`, source: "typed" }) })).json();
      if (j && (j.catalog || j.store_name)) { setRec(j as StoreRecord); setStep(null); }
      else if (j.error) { setErr(j.error); setStep(j); }
      else setStep(j);
      await loadLog();
    } catch { setErr("Can't reach the store engine."); }
    finally { setBusy(false); setDraft(""); }
  }

  async function action(kind: "sync" | "regenerate" | "reset") {
    setBusy(true);
    try {
      if (kind === "reset") { await fetch(`/api/odai/store`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ action: "reset" }) }); setRec(null); setStep(null); await loadLog(); }
      else { const j = await (await fetch(`/api/odai/store`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ action: kind }) })).json(); if (j && j.catalog) setRec(j); await loadLog(); }
    } catch { setErr("action failed"); } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { border: "1px solid var(--line,#2a2f45)", borderRadius: 16, padding: 16 };
  const kv = (k: string, v: React.ReactNode) => <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0", fontSize: 13 }}><span style={{ color: "var(--ink2)" }}>{k}</span><span style={{ textAlign: "right" }}>{v}</span></div>;

  return (
    <div className="view" style={{ padding: "16px", maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
      {err && <p style={{ color: "#e0655f", fontSize: 12 }}>{err}</p>}

      {!rec && (
        <section style={card}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>🏪 Create your online store</h3>
          <p style={{ fontSize: 12.5, color: "var(--ink2)", margin: "0 0 12px" }}>AIVORA will ask for your store name and language, then build the catalog from your existing products and link it to your AIVORA store.</p>
          {!step && <button className="q4send" style={{ padding: "9px 16px" }} onClick={() => send("Help me create an online store.")} disabled={busy}>Start store setup</button>}
          {step?.prompt && (
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <p style={{ fontSize: 13, margin: "8px 0", flex: 1 }}>🤖 {step.prompt}</p>
            </div>
          )}
          {step?.prompt && (
            <div style={{ display: "flex", gap: 8 }}>
              <input className="q4input" style={{ flex: 1 }} placeholder="Type your answer…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(draft); }} />
              <button className="q4send" onClick={() => void send(draft)} disabled={busy || !draft.trim()}>Send</button>
            </div>
          )}
        </section>
      )}

      {rec && (
        <>
          <section style={card}>
            <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>🏪 {rec.store_name} — {rec.integration} store</h3>
            {kv("Store Name", <b>{rec.store_name}</b>)}
            {kv("Language", rec.language)}
            {kv("Store Integration", rec.integration)}
            {kv("Catalog Status", <span style={{ color: rec.catalog_status === "generated" ? "#3fb37f" : "var(--ink2)" }}>{rec.catalog_status}</span>)}
            {kv("Number of Products", rec.product_count)}
            {kv("Last Synchronization", new Date(rec.last_sync).toLocaleString())}
            {kv("Objective", <code style={{ fontSize: 11 }}>{rec.objective_id}</code>)}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <a className="q4send" style={{ padding: "8px 14px", textDecoration: "none", background: rec.published ? "#0e6b6b" : "#5a6076" }} href={rec.public_url} target="_blank" rel="noopener">{rec.open_label}</a>
              <button className="q4send" style={{ padding: "8px 14px" }} onClick={() => void action("sync")} disabled={busy}>Sync Catalog</button>
              <button className="q4send" style={{ padding: "8px 14px", opacity: .85 }} onClick={() => void action("regenerate")} disabled={busy}>Regenerate Catalog</button>
              <a className="q4send" style={{ padding: "8px 14px", opacity: .85, textDecoration: "none" }} href={`/api/odai/store/export?_t=${Date.now()}`} target="_blank" rel="noopener">Export Catalog</a>
            </div>
            <p style={{ fontSize: 11, color: "var(--ink2)", margin: "10px 0 0" }}>
              {rec.published ? "Live public store." : "Store page is a DRAFT — not yet public. Generating a catalog does not publish the website (approval gate held)."}
            </p>
          </section>

          <section style={card}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Catalog preview ({rec.catalog.length} products)</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 10 }}>
              {rec.catalog.map((p) => (
                <div key={p.id} style={{ border: "1px solid var(--line,#2a2f45)", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <img src={p.image} alt={p.name} loading="lazy" style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover" }} />
                  <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                    <b style={{ fontSize: 12 }}>{p.name}</b>
                    <span style={{ fontSize: 12, color: "#3fb37f", fontWeight: 700 }}>{p.currency} {p.price.toFixed(2)}</span>
                    {p.availability == null && <small style={{ color: "var(--ink2)", fontSize: 10 }}>availability: not provided</small>}
                    <a href={p.action.url} target="_blank" rel="noopener" style={{ marginTop: "auto", fontSize: 11, textAlign: "center", background: "#25d366", color: "#fff", padding: "6px", borderRadius: 8, textDecoration: "none" }}>Enquire</a>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 10, color: "var(--ink2)", margin: "8px 0 0" }}>Images reused from the existing Hashmeta media library; prices are owner-provided. No product claims/stock invented.</p>
          </section>

          <section style={card}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>🔗 Hashmeta integration</h4>
            {kv("Public URL", <a href={rec.public_url} target="_blank" rel="noopener" style={{ fontSize: 12 }}>{rec.public_url}</a>)}
            {kv("Sync", <span style={{ color: rec.sync.status === "verified" ? "#3fb37f" : "#e0a23a" }}>{rec.sync.status}</span>)}
            {kv("Runtime auto-sync", <span style={{ fontSize: 11 }}>{rec.sync.runtime_auto_sync}</span>)}
            <p style={{ fontSize: 11, color: "var(--ink2)", margin: "6px 0 0" }}>{rec.sync.basis}</p>
          </section>

          <section style={card}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>🧾 Show what AIVORA did (Execution Line)</h4>
            {log.length === 0 && <p style={{ fontSize: 12, color: "var(--ink2)" }}>No events yet.</p>}
            <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
              {log.map((e, i) => <li key={i} style={{ fontSize: 12 }}><b>{e.kind}</b> <span style={{ color: "var(--ink2)" }}>— {e.note}</span></li>)}
            </ol>
            <button className="q4send" style={{ padding: "6px 12px", marginTop: 10, opacity: .8 }} onClick={() => void action("reset")} disabled={busy}>Start over</button>
          </section>
        </>
      )}
    </div>
  );
}
