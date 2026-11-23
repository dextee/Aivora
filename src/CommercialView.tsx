import { useEffect, useState } from "react";
import { MobileFrame } from "./MobileFrame";

type Job = { job_id: string; status: string; blockers?: { code: string; detail: string }[]; spec?: any; poster_spec?: any; render?: any; poster?: any; merged?: any; product?: any; avatar?: any; attachments?: any[]; publish_target?: { url: string; state: string } };
type Up = { id?: string; name?: string; kind?: string; size?: number };

const b64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
const card: React.CSSProperties = { background: "#fff", borderRadius: 16, padding: 16, marginTop: 12, boxShadow: "0 1px 4px rgba(0,0,0,.06)" };
const primary: React.CSSProperties = { padding: "14px 18px", borderRadius: 12, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" };
const ghost: React.CSSProperties = { padding: "9px 13px", borderRadius: 10, border: "1px solid #0e6b57", background: "#fff", color: "#0e6b57", fontWeight: 700, fontSize: 12.5, cursor: "pointer" };
const field: React.CSSProperties = { padding: 9, borderRadius: 10, border: "1px solid #d7dbe3", fontSize: 13, maxWidth: "100%" };

export function CommercialView() {
  const [products, setProducts] = useState<any[]>([]);
  const [langs, setLangs] = useState<string[]>([]);
  const [productId, setProductId] = useState("");
  const [language, setLanguage] = useState("English");
  const [landing, setLanding] = useState("https://aivora-voice-first-ai-assist.geo.hashmeta.tech/campaign1");
  const [preview, setPreview] = useState(false);
  const [current, setCurrent] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [atts, setAtts] = useState<Up[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => {
    void fetch("/api/odai/shop/products").then(r => r.json()).then(j => { const p = j.products || []; setProducts(p); setProductId((cur) => cur || p[0]?.product_id || ""); }).catch(() => setProducts([]));
    void fetch("/api/odai/company").then(r => r.json()).then(j => setLangs(j.company?.voice_languages_demo || [])).catch(() => setLangs([]));
    void fetch("/api/odai/shop/config").then(r => r.json()).then(j => { if (j.campaign_landing_url) setLanding(j.campaign_landing_url); }).catch(() => { /* keep default */ });
    void fetch("/api/odai/commercial").then(r => r.json()).then(j => setJobs(j.jobs || [])).catch(() => setJobs([]));
  };
  useEffect(load, []);

  async function api(path: string, body?: any) {
    try {
      const r = await fetch("/api/odai/commercial" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error || `Request failed (${r.status})`); return null; }
      load(); return j;
    } catch (e) { setMsg((e as Error).message); return null; }
  }
  async function create() {
    setBusy("Preparing…");
    const j = await api("", { product_id: productId || null, language, aspect_ratio: "9:16", attachment_ids: atts.map(a => a.id).filter(Boolean) });
    setBusy("");
    if (j) {
      setCurrent(j);
      setMsg(j.status === "READY_TO_RENDER"
        ? `Ready: a 15 second ${language} commercial for ${j.product?.name || "your product"} at ${j.spec?.grounded_in?.price || ""}.`
        : (j.blockers || []).map((b: any) => b.detail || b.code).join(" · ") || j.status);
    }
  }
  async function uploadOne(f: File) {
    const data = await b64(f);
    const r = await fetch("/api/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.name, mime: f.type, data }) });
    const j = await r.json();
    if (!r.ok || !j.file?.id) { setMsg(j.error || `Upload failed (${r.status})`); return null; }
    return { id: j.file.id, name: j.file.name, kind: j.file.kind, size: j.file.size };
  }
  async function attachFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy("Attaching…");
    const added: Up[] = [];
    for (const f of Array.from(list)) { const up = await uploadOne(f); if (up) added.push(up); }
    setAtts(p => [...p, ...added]);
    setBusy("");
    setMsg(added.length ? `${added.length} file(s) attached.` : "No file was accepted.");
  }
  async function merge() {
    if (!current) return;
    setBusy("Merging…");
    const j = await api(`/${current.job_id}/merge`, {});
    setBusy("");
    if (j) { setCurrent(j); const m = j.merged || {}; setMsg(m.ok ? `Merged ${m.inputs?.length} file(s) into a ${m.measured_seconds}s ${m.resolution} mp4.` : `Merge ${m.status}: ${m.reason}`); }
  }
  async function attachUploaded(kind: "poster" | "render", f: File) {
    setBusy("Attaching…");
    const up = await uploadOne(f);
    if (!up) { setBusy(""); return; }
    const j = await api(`/${current?.job_id}/${kind}`, { upload_id: up.id, ...(kind === "render" ? { duration_seconds: 15 } : {}) });
    setBusy("");
    if (j) { setCurrent(j); setMsg(kind === "poster" ? `Poster attached (${j.poster?.bytes} B ${j.poster?.format}).` : `Video attached (${j.render?.bytes} B, ${j.render?.duration_seconds ?? "?"}s).`); }
  }

  return (
    <div className="tl" style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "14px 14px 40px" }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>Commercial Studio</h2>
      <p style={{ margin: 0, fontSize: 12.5, color: "#8a93a3" }}>A 15 second commercial for your coffee store. No photo needed.</p>

      {/* The demo action: open the campaign landing page inside AIVORA's mobile frame. */}
      <section style={card}>
        <button onClick={() => setPreview(true)} style={{ ...primary, width: "100%" }}>▶ Video</button>
        <p style={{ fontSize: 11.5, color: "#8a93a3", margin: "10px 0 0", wordBreak: "break-all" }}>{landing}</p>
      </section>

      <section style={card}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Product</label>
        <select value={productId} onChange={e => setProductId(e.target.value)} style={{ ...field, width: "100%" }}>
          {products.map(p => <option key={p.product_id} value={p.product_id}>{p.name} · {p.currency} {Number(p.approved_selling_price).toFixed(2)}</option>)}
        </select>
        <label style={{ display: "block", fontSize: 12, fontWeight: 700, margin: "12px 0 6px" }}>Language</label>
        <select value={language} onChange={e => setLanguage(e.target.value)} style={{ ...field, width: "100%" }}>
          {(langs.length ? langs : ["English"]).map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <button onClick={() => void create()} disabled={!!busy} style={{ ...primary, width: "100%", marginTop: 14, opacity: busy ? 0.6 : 1 }}>
          {busy || "Create the 15 second commercial"}
        </button>
        {msg && <p style={{ fontSize: 12.5, margin: "10px 0 0", color: current?.status === "READY_TO_RENDER" || /Merged|attached|Ready/i.test(msg) ? "#0e6b57" : "#b42318" }}>{msg}</p>}
        <p style={{ fontSize: 11, color: "#8a93a3", margin: "10px 0 0" }}>Prices and claims come from your catalog. Nothing is published and nothing is spent.</p>
      </section>

      {current?.merged?.ok && (
        <section style={card}>
          <video src={`/api/odai/commercial/${current.job_id}/merged`} controls style={{ width: "100%", maxWidth: 320, borderRadius: 12, background: "#000" }} />
          <p style={{ fontSize: 11.5, color: "#8a93a3", margin: "8px 0 0" }}>{current.merged.measured_seconds}s · {current.merged.resolution} · your attached files, merged on this computer.</p>
        </section>
      )}
      {current?.poster && (
        <section style={card}>
          <img src={`/api/odai/commercial/${current.job_id}/poster`} alt="Commercial poster" style={{ width: "100%", maxWidth: 320, borderRadius: 12 }} />
        </section>
      )}
      {current?.render && (
        <section style={card}>
          <video src={`/api/odai/commercial/${current.job_id}/file`} controls style={{ width: "100%", maxWidth: 320, borderRadius: 12, background: "#000" }} />
          <p style={{ fontSize: 11.5, color: "#8a93a3", margin: "8px 0 0" }}>{current.render.duration_seconds ?? "?"}s · {current.render.bytes} B · provider {current.render.provider}</p>
        </section>
      )}

      {/* Everything technical stays out of the way but reachable. */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ fontSize: 12, color: "#8a93a3", cursor: "pointer" }}>Advanced</summary>
        <section style={card}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Your files (images or mp4, up to 9)</label>
          <input type="file" multiple accept="image/*,video/mp4,video/*" onChange={e => void attachFiles(e.target.files)} />
          {atts.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {atts.map(a => <li key={a.id}>{a.name} · {a.kind} · {Math.round((a.size || 0) / 1024)} KB <button onClick={() => setAtts(p => p.filter(x => x.id !== a.id))} style={{ marginLeft: 6, border: 0, background: "none", color: "#b42318", cursor: "pointer", fontSize: 11 }}>remove</button></li>)}
            </ul>
          )}
          {current && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <button onClick={() => void merge()} disabled={!!busy || !(current.attachments || []).some(a => a.mergeable)} style={{ ...ghost, opacity: (current.attachments || []).some(a => a.mergeable) ? 1 : 0.5 }}>Merge into a 15 s mp4</button>
              <label style={{ ...ghost, display: "inline-flex", alignItems: "center" }}>
                Attach poster
                <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) void attachUploaded("poster", f); }} />
              </label>
              <label style={{ ...ghost, display: "inline-flex", alignItems: "center" }}>
                Attach video
                <input type="file" accept="video/mp4,video/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) void attachUploaded("render", f); }} />
              </label>
              <button onClick={async () => { const j = await api(`/${current.job_id}/dispatch`, {}); if (j) { setCurrent(j); setMsg("Handed to the video provider."); } }} style={ghost}>Hand to provider</button>
            </div>
          )}
          {current?.spec && (
            <details style={{ fontSize: 12, marginTop: 12 }}>
              <summary style={{ cursor: "pointer", color: "#8a93a3" }}>Video and poster specs</summary>
              <p style={{ margin: "6px 0" }}>{current.spec.model} · {current.spec.duration_seconds}s · {current.spec.resolution} · {current.spec.aspect_ratio} · references {current.spec.reference_images?.length ?? 0}</p>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 8, borderRadius: 8, fontSize: 11 }}>{current.spec.prompt}</pre>
              {current.poster_spec && <pre style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 8, borderRadius: 8, fontSize: 11 }}>{current.poster_spec.prompt}</pre>}
            </details>
          )}
          {jobs.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Jobs ({jobs.length})</div>
              {jobs.slice(0, 8).map(j => (
                <button key={j.job_id} onClick={async () => { const r = await fetch(`/api/odai/commercial/${j.job_id}`); if (r.ok) { setCurrent(await r.json()); setMsg(`Opened ${j.job_id}.`); } }}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "#fff", border: "1px solid #eef0f4", borderRadius: 10, padding: "8px 10px", marginBottom: 6, cursor: "pointer", fontSize: 12 }}>
                  <b>{j.job_id}</b> · {j.status.replace(/_/g, " ").toLowerCase()} · {j.product?.name || "no product"}
                </button>
              ))}
            </div>
          )}
        </section>
      </details>

      {preview && (
        <MobileFrame url={landing} title="Coffee-store commercial" onClose={() => setPreview(false)} />
      )}
    </div>
  );
}
