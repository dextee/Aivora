import { useEffect, useState } from "react";

type Job = { job_id: string; status: string; blockers?: { code: string; detail: string }[]; spec?: any; render?: any; product?: any; avatar?: any; provider_task_id?: string };
type Up = { upload_id: string; ext: string; bytes: number; sha256: string };

const b64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
const STATUS_COLOR: Record<string, string> = { READY_TO_RENDER: "#0e6b57", PENDING_PROVIDER: "#b54708", RENDERED: "#2f7a3e", BLOCKED: "#b42318", REJECTED: "#b42318", DRAFT_INPUTS_MISSING: "#8a93a3" };

export function CommercialView() {
  const [provider, setProvider] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [langs, setLangs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [consent, setConsent] = useState(false);
  const [avatar, setAvatar] = useState<Up | null>(null);
  const [productImg, setProductImg] = useState<Up | null>(null);
  const [productId, setProductId] = useState("");
  const [facts, setFacts] = useState({ name: "", price: "", currency: "SGD" });
  const [language, setLanguage] = useState("English");
  const [aspect, setAspect] = useState("9:16");
  const [current, setCurrent] = useState<Job | null>(null);
  const [renderPath, setRenderPath] = useState("");
  const [renderDur, setRenderDur] = useState("15");
  const [msg, setMsg] = useState("");

  const load = () => {
    void fetch("/api/odai/commercial/provider").then(r => r.json()).then(setProvider).catch(() => setProvider(null));
    void fetch("/api/odai/shop/products").then(r => r.json()).then(j => setProducts(j.products || [])).catch(() => setProducts([]));
    void fetch("/api/odai/company").then(r => r.json()).then(j => setLangs(j.company?.voice_languages_demo || [])).catch(() => setLangs([]));
    void fetch("/api/odai/commercial").then(r => r.json()).then(j => setJobs(j.jobs || [])).catch(() => setJobs([]));
  };
  useEffect(load, []);

  async function api(path: string, body?: any) {
    try {
      const r = await fetch("/api/odai/commercial" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { setMsg(`✗ ${j.error || r.status}`); return null; }
      setMsg(""); load(); return j;
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); return null; }
  }
  async function upload(kind: "avatar" | "product", f: File) {
    const data = await b64(f);
    const j = await api("/input", { kind, filename: f.name, data_base64: data, likeness_consent: kind === "avatar" ? consent : false });
    if (j) { if (kind === "avatar") setAvatar(j); else setProductImg(j); setMsg(`${kind} stored: ${j.upload_id} · ${j.ext} · ${j.bytes} B · sha256 ${j.sha256.slice(0, 12)}…`); }
  }
  async function create() {
    const j = await api("", {
      avatar_upload_id: avatar?.upload_id || null,
      product_id: productId || null,
      product_upload_id: !productId && productImg ? productImg.upload_id : null,
      product_facts: !productId && productImg ? { name: facts.name, price: Number(facts.price), currency: facts.currency } : null,
      language, aspect_ratio: aspect,
    });
    if (j) { setCurrent(j); setMsg(j.status === "READY_TO_RENDER" ? `✓ ${j.job_id} spec ready — 15 s, ${j.spec.resolution}, ${j.spec.reference_images.length} references. No video exists yet.` : `${j.job_id} ${j.status}: ${(j.blockers || []).map((b: any) => b.code).join(", ")}`); }
  }

  return (
    <div className="tl" style={{ padding: 14 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Commercial Studio — “Create commercial with avatar”</h2>
      <p style={{ margin: 0, fontSize: 12, color: "#8a93a3" }}>
        Attach your own photo and a product; AIVORA validates both, grounds the script in the real catalog and hands a
        {provider ? ` ${provider.duration_seconds}s ${provider.resolution} spec to ${provider.model}` : " 15 s spec to the authorized provider"}.
        The video is <b>never fabricated here</b> — the job stays PENDING_PROVIDER until a real render is attached and verified.
      </p>

      <section style={{ background: "#fff", borderRadius: 14, padding: 14, marginTop: 12, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>1 · Your photo (avatar)</h3>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          I consent to my likeness being used in this commercial (required — control G12)
        </label>
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!consent}
          onChange={e => { const f = e.target.files?.[0]; if (f) void upload("avatar", f); }} />
        {avatar && <p style={{ fontSize: 12, color: "#0e6b57" }}>stored {avatar.upload_id} · {avatar.ext} · {avatar.bytes} B</p>}
        {!consent && <p style={{ fontSize: 11, color: "#b42318" }}>Consent must be ticked first — the upload is refused with 403 otherwise.</p>}
      </section>

      <section style={{ background: "#fff", borderRadius: 14, padding: 14, marginTop: 10, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>2 · Product</h3>
        <select value={productId} onChange={e => setProductId(e.target.value)} style={{ padding: 7, borderRadius: 8, minWidth: 260 }}>
          <option value="">— choose a catalog product (facts verified) —</option>
          {products.map(p => <option key={p.product_id} value={p.product_id}>{p.name} · {p.currency} {Number(p.approved_selling_price).toFixed(2)}</option>)}
        </select>
        <div style={{ margin: "10px 0", fontSize: 12, color: "#8a93a3" }}>or attach a product photo and state the facts (prices are never inferred — control G13)</div>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) void upload("product", f); }} />
        {productImg && !productId && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <input placeholder="product name" value={facts.name} onChange={e => setFacts({ ...facts, name: e.target.value })} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3" }} />
            <input placeholder="price" value={facts.price} onChange={e => setFacts({ ...facts, price: e.target.value })} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: 90 }} />
            <input placeholder="currency" value={facts.currency} onChange={e => setFacts({ ...facts, currency: e.target.value })} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: 80 }} />
          </div>
        )}
      </section>

      <section style={{ background: "#fff", borderRadius: 14, padding: 14, marginTop: 10, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>3 · Language and format</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={language} onChange={e => setLanguage(e.target.value)} style={{ padding: 7, borderRadius: 8 }}>
            {(langs.length ? langs : ["English"]).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={aspect} onChange={e => setAspect(e.target.value)} style={{ padding: 7, borderRadius: 8 }}>
            {["9:16", "1:1", "16:9"].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button onClick={() => void create()} style={{ padding: "8px 14px", borderRadius: 10, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, cursor: "pointer" }}>Create 15 s commercial spec</button>
        </div>
        {msg && <p style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("✗") ? "#b42318" : "#0e6b57" }}>{msg}</p>}
      </section>

      {current && (
        <section style={{ background: "#fff", borderRadius: 14, padding: 14, marginTop: 10, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>{current.job_id} · <span style={{ color: STATUS_COLOR[current.status] || "#101828" }}>{current.status}</span></h3>
          {(current.blockers || []).map((b, i) => <p key={i} style={{ fontSize: 12, color: "#b42318", margin: "2px 0" }}>{b.code}: {b.detail}</p>)}
          {current.spec && (
            <details open style={{ fontSize: 12 }}>
              <summary>Provider render spec (grounded, no invented claims)</summary>
              <p style={{ margin: "6px 0" }}><b>{current.spec.model}</b> · {current.spec.mode} · {current.spec.duration_seconds} s · {current.spec.resolution} · {current.spec.aspect_ratio} · audio {String(current.spec.generate_audio)}</p>
              <p style={{ margin: "4px 0" }}>references: {current.spec.reference_roles?.join(" + ")}</p>
              <p style={{ margin: "4px 0" }}>grounded in: {current.spec.grounded_in?.product_source} · {current.spec.grounded_in?.product_id || "owner-stated"} · {current.spec.grounded_in?.price} · catalog_verified={String(current.spec.grounded_in?.catalog_verified)}</p>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 8, borderRadius: 8 }}>{current.spec.prompt}</pre>
              <pre style={{ whiteSpace: "pre-wrap", background: "#fff6f5", padding: 8, borderRadius: 8 }}>negative: {current.spec.negative_prompt}</pre>
            </details>
          )}
          {current.status === "READY_TO_RENDER" && <button onClick={async () => { const j = await api(`/${current.job_id}/dispatch`, { provider_task_id: null }); if (j) setCurrent(j); }} style={{ marginTop: 8, padding: "8px 12px", borderRadius: 10, border: "1px solid #b54708", background: "#fff", color: "#b54708", fontWeight: 700, cursor: "pointer" }}>Hand spec to the media provider</button>}
          {(current.status === "PENDING_PROVIDER" || current.status === "RENDERED") && (
            <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input placeholder="rendered file path (mp4)" value={renderPath} onChange={e => setRenderPath(e.target.value)} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", minWidth: 280 }} />
              <input placeholder="duration s" value={renderDur} onChange={e => setRenderDur(e.target.value)} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: 90 }} />
              <button onClick={async () => { const j = await api(`/${current.job_id}/render`, { file_path: renderPath, duration_seconds: Number(renderDur) }); if (j) setCurrent(j); }} style={{ padding: "8px 12px", borderRadius: 10, border: 0, background: "#2f7a3e", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Attach real render</button>
            </div>
          )}
          {current.status === "RENDERED" && current.render && (
            <div style={{ marginTop: 10 }}>
              <video src={`/api/odai/commercial/${current.job_id}/file`} controls style={{ width: "100%", maxWidth: 340, borderRadius: 12, background: "#000" }} />
              <p style={{ fontSize: 11, color: "#8a93a3" }}>{current.render.bytes} B · {current.render.container} · {current.render.duration_seconds ?? "unreported"} s · sha256 {current.render.sha256.slice(0, 16)}… · provider {current.render.provider}</p>
            </div>
          )}
        </section>
      )}

      <section style={{ marginTop: 10 }}>
        <h3 style={{ fontSize: 14 }}>Jobs ({jobs.length})</h3>
        {jobs.map(j => (
          <button key={j.job_id} onClick={async () => { const r = await fetch(`/api/odai/commercial/${j.job_id}`); if (r.ok) setCurrent(await r.json()); }}
            style={{ display: "block", width: "100%", textAlign: "left", background: "#fff", border: "1px solid #eef0f4", borderRadius: 10, padding: "8px 10px", marginBottom: 6, cursor: "pointer", fontSize: 12 }}>
            <b>{j.job_id}</b> · <span style={{ color: STATUS_COLOR[j.status] || "#101828", fontWeight: 700 }}>{j.status}</span> · {j.product?.name || "no product"} {j.render ? `· render ${j.render.bytes} B` : "· no render"}
          </button>
        ))}
        {!jobs.length && <p style={{ fontSize: 12, color: "#8a93a3" }}>No commercial jobs yet.</p>}
      </section>
    </div>
  );
}
