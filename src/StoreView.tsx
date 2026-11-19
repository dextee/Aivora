import { useEffect, useRef, useState } from "react";
import { storeGenerate, storeDiag, type StoreSpec } from "./lib";

/* AIVORA Online Store builder — generates an ecommerce catalog page.
 * Backend bridge (server/hashmeta.mjs) prefers the Hashmeta connector tool and
 * falls back to AIVORA's own generator (qwen3.8-omni-flash). */

const MARKETS = ["Singapore", "Malaysia", "Indonesia", "Thailand", "Philippines", "Global"];
const LANGS = [["en", "English"], ["zh", "中文"], ["ms", "Bahasa Melayu"], ["id", "Bahasa Indonesia"], ["th", "ไทย"]] as const;

export type StoreSeed = (Partial<StoreSpec> & { store_name?: string }) | null;

export function StoreView({ seed, onBack }: { seed: StoreSeed; onBack(): void }) {
  const [storeName, setStoreName] = useState(seed?.storeName || seed?.store_name || "");
  const [products, setProducts] = useState(seed?.products || "");
  const [market, setMarket] = useState(seed?.market || "Singapore");
  const [language, setLanguage] = useState(seed?.language || "en");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [out, setOut] = useState<{ mode: string; tool: string; result: string; note?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    storeDiag().then((d) => setEngine(d.hashmeta_token && d.tools?.length
      ? `Hashmeta connector ready (${d.tools.map((t) => t.name).slice(0, 3).join(", ")}${d.tools.length > 3 ? "…" : ""})`
      : "Hashmeta token not set yet — AIVORA local generator will be used")).catch(() => setEngine(null));
  }, []);

  async function generate() {
    setErr(null); setOut(null); setBusy(true);
    try {
      const spec: StoreSpec = { storeName: storeName.trim(), products, market, language };
      setElapsed(0);
      const j = await storeGenerate({ ...spec, language: LANGS.find(([v]) => v === language)?.[1] || language } as StoreSpec);
      if (j.result) {
        setOut({ mode: j.mode || "?", tool: j.tool || "?", result: j.result, note: j.note });
        setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      } else setErr(j.error || "empty response");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const isHtml = !!out && /<\/?i?html|<!doctype/i.test(out.result);
  const urlInResult = out?.result.match(/https?:\/\/[^\s"'<>]+/)?.[0];

  function openFull() {
    if (isHtml) {
      const blob = new Blob([out!.result], { type: "text/html" });
      window.open(URL.createObjectURL(blob), "_blank");
    } else if (urlInResult) window.open(urlInResult, "_blank");
  }
  function download() {
    const blob = new Blob([out!.result], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(storeName || "store").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-catalog.html`;
    a.click();
  }

  return (
    <>
      {engine && <div className="seclabel" style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11 }}>
        <span className={`st-dot ${engine.startsWith("Hashmeta") ? "ok" : "warn"}`} />{engine}
      </div>}
      <div className="docspad">
        <div className="optcard">
          <h4>🏪 STORE</h4>
          <label className="fld"><span>Store name</span>
            <input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="e.g. Kaava Coffee_sg" style={{ width: "100%", border: "1.5px solid var(--line)", borderRadius: 12, padding: "11px 12px", font: "600 13px var(--font)", outline: "none" }} />
          </label>
          <label className="fld"><span>Products (one per line: name — price — note)</span>
            <textarea className="darea" value={products} onChange={(e) => setProducts(e.target.value)}
              placeholder={"Kopi blend 250g — S$12 — hokkien toast roast\nCaramel cold brew — S$8 — limited batch\nGift set x3 — S$30 — best seller"} style={{ minHeight: 110 }} />
          </label>
        </div>
        <div className="optcard">
          <h4>🌏 MARKET & LANGUAGE</h4>
          <div className="optrow">
            {MARKETS.map((m) => <button key={m} className={`lpill${market === m ? " sel" : ""}`} onClick={() => setMarket(m)}>{m}</button>)}
          </div>
          <div className="optrow" style={{ marginTop: 8 }}>
            {LANGS.map(([v, l]) => <button key={v} className={`lpill${language === v ? " sel" : ""}`} onClick={() => setLanguage(v)}>{l}</button>)}
          </div>
        </div>

        <button className="gobtn" disabled={busy || (!storeName.trim() && !products.trim())} onClick={generate}>
          {busy ? `Generating… ${elapsed}s` : "🛒 Generate catalog page"}
        </button>

        {err && <p className="mstat bad" style={{ marginTop: 12 }}>✕ {err}</p>}

        {out && (
          <div ref={resultRef} style={{ marginTop: 14 }}>
            <div className="transout">
              <span className="chip2">{out.mode === "hashmeta" ? "✓ VIA HASHMETA CONNECTOR" : out.mode === "aivora-fallback" ? "HASHMETA UNAVAILABLE → AIVORA BUILT" : "AIVORA LOCAL BUILDER"}{(out as { partial?: boolean }).partial ? " · quick draft (still useful — regenerate anytime)" : ""}</span>
              <p style={{ fontSize: 12, color: "var(--ink2)", margin: "6px 0 10px" }}>tool: <b>{out.tool}</b>{out.note ? ` · note: ${out.note.slice(0, 120)}` : ""}</p>
              {isHtml
                ? <iframe title="catalog preview" sandbox="allow-scripts" srcDoc={out.result}
                    style={{ width: "100%", height: 380, border: "1.5px solid var(--line)", borderRadius: 12, background: "#fff" }} />
                : <div className="result" style={{ fontSize: 13.5 }}>{out.result}</div>}
              {urlInResult && <p style={{ marginTop: 8, fontSize: 12.5 }}>🔗 <a href={urlInResult} target="_blank" rel="noreferrer" style={{ color: "var(--wa-teal)", fontWeight: 700 }}>{urlInResult}</a></p>}
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button className="mab" onClick={onBack}>Back to talk</button>
                {isHtml && <button className="mab" onClick={download}>⬇ HTML</button>}
                <button className="mab solid" onClick={openFull}>👁 Full preview</button>
              </div>
            </div>
            <p className="dnote">Ask AIVORA on the green button: <b>“make me an online store page for …”</b> — it routes here automatically. The connector calls Hashmeta's catalog tool when configured; otherwise AIVORA generates the page itself.</p>
          </div>
        )}
      </div>
    </>
  );
}
