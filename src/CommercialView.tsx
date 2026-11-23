import { useEffect, useState } from "react";
import { MobileFrame } from "./MobileFrame";

type Job = { job_id: string; status: string; blockers?: { code: string; detail: string }[]; spec?: any; poster_spec?: any; render?: any; poster?: any; merged?: any; product?: any; avatar?: any; attachments?: any[]; provider_task_id?: string; publish_target?: { url: string; page_id?: number; page_title?: string; state: string; requires?: string } };
type Up = { upload_id?: string; id?: string; name?: string; ext?: string; kind?: string; bytes?: number; size?: number; sha256?: string };

const b64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
const STATUS_COLOR: Record<string, string> = { READY_TO_RENDER: "#0e6b57", PENDING_PROVIDER: "#b54708", RENDERED: "#2f7a3e", BLOCKED: "#b42318", REJECTED: "#b42318", DRAFT_INPUTS_MISSING: "#8a93a3" };
const card: React.CSSProperties = { background: "#fff", borderRadius: 14, padding: 14, marginTop: 10, boxShadow: "0 1px 4px rgba(0,0,0,.06)" };
const btn: React.CSSProperties = { padding: "9px 13px", borderRadius: 10, border: 0, background: "#0e6b57", color: "#fff", fontWeight: 800, fontSize: 12.5, cursor: "pointer" };
const ghost: React.CSSProperties = { padding: "9px 13px", borderRadius: 10, border: "1px solid #0e6b57", background: "#fff", color: "#0e6b57", fontWeight: 700, fontSize: 12.5, cursor: "pointer" };

export function CommercialView() {
  const [provider, setProvider] = useState<any>(null);
  const [cap, setCap] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [langs, setLangs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [consent, setConsent] = useState(false);
  const [avatar, setAvatar] = useState<Up | null>(null);
  const [productImg, setProductImg] = useState<Up | null>(null);
  const [atts, setAtts] = useState<Up[]>([]);
  const [productId, setProductId] = useState("");
  const [facts, setFacts] = useState({ name: "", price: "", currency: "SGD" });
  const [language, setLanguage] = useState("English");
  const [aspect, setAspect] = useState("9:16");
  const [current, setCurrent] = useState<Job | null>(null);
  const [renderPath, setRenderPath] = useState("");
  const [renderDur, setRenderDur] = useState("15");
  const [preview, setPreview] = useState(false);
  const [landing, setLanding] = useState("https://aivora-voice-first-ai-assist.geo.hashmeta.tech/campaign1");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => {
    void fetch("/api/odai/commercial/provider").then(r => r.json()).then(setProvider).catch(() => setProvider(null));
    void fetch("/api/odai/commercial/capability").then(r => r.json()).then(setCap).catch(() => setCap(null));
    /* the demo landing page is a protected constant served by the app, not hard-coded guesswork */
    void fetch("/api/odai/shop/config").then(r => r.json()).then(j => { if (j.campaign_landing_url) setLanding(j.campaign_landing_url); }).catch(() => { /* keep the default */ });
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
  /* composer-style upload: bytes stay on this server (odai/uploads), never forwarded anywhere */
  async function uploadOne(f: File) {
    const data = await b64(f);
    const r = await fetch("/api/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.name, mime: f.type, data }) });
    const j = await r.json();
    if (!r.ok || !j.file?.id) { setMsg(`✗ ${j.error || r.status} — ${f.name}`); return null; }
    return { id: j.file.id, name: j.file.name, kind: j.file.kind, size: j.file.size };
  }
  async function attachFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy("uploading…");
    const added: Up[] = [];
    for (const f of Array.from(list)) { const up = await uploadOne(f); if (up) added.push(up); }
    setAtts(prev => [...prev, ...added]);
    setBusy("");
    setMsg(added.length ? `${added.length} file(s) attached: ${added.map(a => `${a.name} (${a.kind})`).join(", ")}` : "no file was accepted");
  }
  async function uploadAvatar(f: File) {
    setBusy("storing avatar…");
    const data = await b64(f);
    const j = await api("/input", { kind: "avatar", filename: f.name, data_base64: data, likeness_consent: consent });
    setBusy("");
    if (j) { setAvatar(j); setMsg(`avatar stored: ${j.upload_id} · ${j.ext} · ${j.bytes} B · sha256 ${String(j.sha256).slice(0, 12)}…`); }
  }
  async function uploadProduct(f: File) {
    setBusy("storing product photo…");
    const data = await b64(f);
    const j = await api("/input", { kind: "product", filename: f.name, data_base64: data });
    setBusy("");
    if (j) { setProductImg(j); setMsg(`product photo stored: ${j.upload_id} · ${j.ext} · ${j.bytes} B`); }
  }
  async function create() {
    setBusy("creating job…");
    const j = await api("", {
      avatar_upload_id: avatar?.upload_id || null,
      product_id: productId || null,
      product_upload_id: !productId && productImg ? productImg.upload_id : null,
      product_facts: !productId && productImg ? { name: facts.name, price: Number(facts.price), currency: facts.currency } : null,
      attachment_ids: atts.map(a => a.id).filter(Boolean),
      language, aspect_ratio: aspect,
    });
    setBusy("");
    if (j) {
      setCurrent(j);
      setMsg(j.status === "READY_TO_RENDER"
        ? `✓ ${j.job_id} — 15 s video spec + poster spec ready (${j.spec?.reference_images?.length ?? 0} video refs, ${j.poster_spec?.reference_images?.length ?? 0} poster refs). Nothing generated yet.`
        : `${j.job_id} ${j.status}: ${(j.blockers || []).map((b: any) => b.detail || b.code).join(" · ")}`);
    }
  }
  async function merge() {
    if (!current) return;
    setBusy("merging with ffmpeg…");
    const j = await api(`/${current.job_id}/merge`, {});
    setBusy("");
    if (j) { setCurrent(j); const m = j.merged || {}; setMsg(m.ok ? `✓ merged ${m.inputs?.length} file(s) → ${m.measured_seconds}s ${m.resolution} mp4 (${m.bytes} B)` : `✗ merge ${m.status}: ${m.reason}`); }
  }
  async function attachFromUpload(kind: "poster" | "render", f: File) {
    setBusy(`uploading ${kind}…`);
    const up = await uploadOne(f);
    if (!up) { setBusy(""); return; }
    const j = await api(`/${current?.job_id}/${kind}`, kind === "poster" ? { upload_id: up.id } : { upload_id: up.id, duration_seconds: Number(renderDur) || null });
    setBusy("");
    if (j) { setCurrent(j); setMsg(`✓ ${kind} attached: ${kind === "poster" ? `${j.poster?.bytes} B ${j.poster?.format}` : `${j.render?.bytes} B ${j.render?.container} ${j.render?.duration_seconds ?? "?"}s`}`); }
  }

  return (
    /* The app shell is height:100dvh with overflow:hidden, so this view owns its scroll region. */
    <div className="tl" style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "14px 14px 40px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Commercial Studio — “Create commercial with avatar”</h2>
      <p style={{ margin: 0, fontSize: 12, color: "#8a93a3" }}>
        Attach your own photo and a product; AIVORA validates both, grounds the script in the real catalog, and produces a
        {provider ? ` ${provider.duration_seconds} s ${provider.resolution} video spec and a poster spec for ${provider.model}` : " 15 s video spec and a poster spec"}.
        Attached files can be merged into one mp4 locally. The AI render is <b>never fabricated here</b> — the job stays PENDING_PROVIDER until a real file is attached and verified.
      </p>

      {/* Demo flow (owner instruction 2026-11-23): the video button opens the campaign landing
          page inside AIVORA's mobile frame. Opening a page is not a publish and spends nothing. */}
      <section style={{ ...card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => setPreview(true)} style={{ ...btn, fontSize: 14, padding: "12px 16px" }}>▶ Video</button>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Coffee-store commercial</div>
          <div style={{ fontSize: 11, color: "#8a93a3", wordBreak: "break-all" }}>{landing}</div>
          <div style={{ fontSize: 11, color: "#8a93a3" }}>Opens in the mobile frame (528 px) with a back button to AIVORA.</div>
        </div>
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Skills available right now</h3>
        <p style={{ margin: 0, fontSize: 12 }}>
          🎬 video provider: <b>{provider?.model || "—"}</b> ({provider?.mode || "—"}, {provider?.duration_seconds || 15} s, {provider?.resolution || "1080p"})
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 12 }}>
          🧩 merge engine: {cap?.merge?.available
            ? <b style={{ color: "#2f7a3e" }}>{String(cap.merge.version || "ffmpeg").split(" ").slice(0, 3).join(" ")}</b>
            : <b style={{ color: "#b42318" }}>BLOCKED — {cap?.merge?.reason || "ffmpeg not resolvable"}</b>}
          {cap?.merge?.available ? ` · found via ${cap.merge.source}` : ""}
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "#8a93a3" }}>{provider?.note}</p>
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>1 · Your photo (avatar)</h3>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          I consent to my likeness being used in this commercial (required — control G12)
        </label>
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!consent}
          onChange={e => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); }} />
        {avatar && <p style={{ fontSize: 12, color: "#0e6b57" }}>stored {avatar.upload_id} · {avatar.ext} · {avatar.bytes} B</p>}
        {!consent && <p style={{ fontSize: 11, color: "#b42318" }}>Consent must be ticked first — the upload is refused with 403 otherwise.</p>}
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>2 · Product</h3>
        <select value={productId} onChange={e => setProductId(e.target.value)} style={{ padding: 8, borderRadius: 8, minWidth: 240, maxWidth: "100%" }}>
          <option value="">— choose a catalog product (facts verified) —</option>
          {products.map(p => <option key={p.product_id} value={p.product_id}>{p.name} · {p.currency} {Number(p.approved_selling_price).toFixed(2)}</option>)}
        </select>
        <div style={{ margin: "10px 0 6px", fontSize: 12, color: "#8a93a3" }}>or attach a product photo and state the facts (prices are never inferred — control G13)</div>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) void uploadProduct(f); }} />
        {productImg && !productId && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <input placeholder="product name" value={facts.name} onChange={e => setFacts({ ...facts, name: e.target.value })} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", flex: 1, minWidth: 140 }} />
            <input placeholder="price" value={facts.price} onChange={e => setFacts({ ...facts, price: e.target.value })} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: 84 }} />
            <input placeholder="currency" value={facts.currency} onChange={e => setFacts({ ...facts, currency: e.target.value })} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: 76 }} />
          </div>
        )}
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>3 · Files to merge into the video <span style={{ fontWeight: 400, color: "#8a93a3", fontSize: 11 }}>(images and mp4 clips, max 9)</span></h3>
        <input type="file" multiple accept="image/*,video/mp4,video/*" onChange={e => void attachFiles(e.target.files)} />
        {atts.length > 0 && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {atts.map(a => <li key={a.id}><b>{a.name}</b> · {a.kind} · {Math.round((a.size || 0) / 1024)} KB <button onClick={() => setAtts(p => p.filter(x => x.id !== a.id))} style={{ marginLeft: 6, border: 0, background: "none", color: "#b42318", cursor: "pointer", fontSize: 11 }}>remove</button></li>)}
          </ul>
        )}
        {!atts.length && <p style={{ fontSize: 11, color: "#8a93a3", margin: "6px 0 0" }}>Nothing attached yet. You can also attach files in Talk to AIVORA and say “generate a video and poster for my coffee store”.</p>}
      </section>

      <section style={card}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>4 · Language and format</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={language} onChange={e => setLanguage(e.target.value)} style={{ padding: 8, borderRadius: 8 }}>
            {(langs.length ? langs : ["English"]).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={aspect} onChange={e => setAspect(e.target.value)} style={{ padding: 8, borderRadius: 8 }}>
            {["9:16", "1:1", "16:9"].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button onClick={() => void create()} disabled={!!busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>Create 15 s commercial spec</button>
        </div>
        {(busy || msg) && <p style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("✗") ? "#b42318" : "#0e6b57" }}>{busy || msg}</p>}
      </section>

      {current && (
        <section style={card}>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>{current.job_id} · <span style={{ color: STATUS_COLOR[current.status] || "#101828" }}>{current.status}</span></h3>
          {(current.blockers || []).map((b, i) => <p key={i} style={{ fontSize: 12, color: "#b42318", margin: "2px 0" }}>{b.code}: {b.detail}</p>)}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button onClick={() => void merge()} disabled={!!busy || !(current.attachments || []).some(a => a.mergeable)} style={{ ...ghost, opacity: (current.attachments || []).some(a => a.mergeable) ? 1 : 0.5 }}>
              🧩 Merge {(current.attachments || []).filter(a => a.mergeable).length} attached file(s) into a 15 s mp4
            </button>
            {current.status === "READY_TO_RENDER" && <button onClick={async () => { const j = await api(`/${current.job_id}/dispatch`, { provider_task_id: null }); if (j) setCurrent(j); }} style={ghost}>🎬 Hand spec to the video provider</button>}
          </div>

          {current.merged && (
            <div style={{ marginTop: 10, borderTop: "1px solid #eef0f4", paddingTop: 8 }}>
              <p style={{ fontSize: 12, margin: 0 }}>
                <b style={{ color: current.merged.ok ? "#2f7a3e" : "#b42318" }}>{current.merged.status}</b>
                {current.merged.ok ? ` · ${current.merged.measured_seconds}s of ${current.merged.requested_seconds}s · ${current.merged.resolution} · ${current.merged.bytes} B · sha256 ${String(current.merged.sha256).slice(0, 12)}… · ${current.merged.ffmpeg?.version?.split(" ")[2] || "ffmpeg"}` : ` · ${current.merged.reason}`}
              </p>
              {current.merged.ok && <>
                <video src={`/api/odai/commercial/${current.job_id}/merged`} controls style={{ width: "100%", maxWidth: 300, borderRadius: 12, background: "#000", marginTop: 8 }} />
                <p style={{ fontSize: 11, color: "#8a93a3", margin: "4px 0 0" }}>{current.merged.note}</p>
              </>}
            </div>
          )}

          {current.spec && (
            <details style={{ fontSize: 12, marginTop: 10 }}>
              <summary>Video spec (grounded, no invented claims)</summary>
              <p style={{ margin: "6px 0" }}><b>{current.spec.model}</b> · {current.spec.mode} · {current.spec.duration_seconds} s · {current.spec.resolution} · {current.spec.aspect_ratio}</p>
              <p style={{ margin: "4px 0" }}>references: {current.spec.reference_roles?.join(" + ")}</p>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 8, borderRadius: 8 }}>{current.spec.prompt}</pre>
            </details>
          )}
          {current.poster_spec && (
            <details style={{ fontSize: 12, marginTop: 8 }}>
              <summary>Poster spec</summary>
              <p style={{ margin: "6px 0" }}>text on poster: {JSON.stringify(current.poster_spec.text_on_poster)}</p>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 8, borderRadius: 8 }}>{current.poster_spec.prompt}</pre>
            </details>
          )}

          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderTop: "1px solid #eef0f4", paddingTop: 8 }}>
            <label style={{ ...ghost, display: "inline-flex", alignItems: "center", gap: 6 }}>
              🖼 Attach real poster
              <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) void attachFromUpload("poster", f); }} />
            </label>
            <label style={{ ...ghost, display: "inline-flex", alignItems: "center", gap: 6 }}>
              🎞 Attach real render
              <input type="file" accept="video/mp4,video/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) void attachFromUpload("render", f); }} />
            </label>
            <input placeholder="duration s" value={renderDur} onChange={e => setRenderDur(e.target.value)} style={{ padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: 84 }} />
          </div>
          <input placeholder="…or a server-side file path for the render" value={renderPath} onChange={e => setRenderPath(e.target.value)} style={{ marginTop: 6, padding: 7, borderRadius: 8, border: "1px solid #d7dbe3", width: "100%" }} />
          {renderPath && <button onClick={async () => { const j = await api(`/${current.job_id}/render`, { file_path: renderPath, duration_seconds: Number(renderDur) || null }); if (j) setCurrent(j); }} style={{ ...ghost, marginTop: 6 }}>Attach render from path</button>}

          {current.poster && <div style={{ marginTop: 10 }}><img src={`/api/odai/commercial/${current.job_id}/poster`} alt="attached poster" style={{ width: "100%", maxWidth: 300, borderRadius: 12 }} /><p style={{ fontSize: 11, color: "#8a93a3" }}>{current.poster.bytes} B · {current.poster.format} · sha256 {String(current.poster.sha256).slice(0, 16)}…</p></div>}
          {current.status === "RENDERED" && current.render && (
            <div style={{ marginTop: 10 }}>
              <video src={`/api/odai/commercial/${current.job_id}/file`} controls style={{ width: "100%", maxWidth: 300, borderRadius: 12, background: "#000" }} />
              <p style={{ fontSize: 11, color: "#8a93a3" }}>{current.render.bytes} B · {current.render.container} · {current.render.duration_seconds ?? "unreported"} s · provider {current.render.provider}</p>
            </div>
          )}

          {current.publish_target && (
            <div style={{ marginTop: 10, borderTop: "1px solid #eef0f4", paddingTop: 8 }}>
              <p style={{ fontSize: 12, margin: "0 0 6px" }}>
                Landing page: <b style={{ wordBreak: "break-all" }}>{current.publish_target.url}</b>
                {current.publish_target.page_id ? ` · page ${current.publish_target.page_id} “${current.publish_target.page_title}”` : ""} · {" "}
                <span style={{ color: current.publish_target.state === "NOT_PUBLISHED" ? "#b54708" : "#2f7a3e", fontWeight: 800 }}>{current.publish_target.state}</span>
              </p>
              <button onClick={() => setPreview(true)} style={ghost}>Preview landing page (mobile frame)</button>
              <p style={{ fontSize: 11, color: "#8a93a3", margin: "6px 0 0" }}>{current.publish_target.requires}</p>
            </div>
          )}
        </section>
      )}

      <section style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 14 }}>Jobs ({jobs.length})</h3>
        {jobs.map(j => (
          <button key={j.job_id} onClick={async () => { const r = await fetch(`/api/odai/commercial/${j.job_id}`); if (r.ok) setCurrent(await r.json()); }}
            style={{ display: "block", width: "100%", textAlign: "left", background: "#fff", border: "1px solid #eef0f4", borderRadius: 10, padding: "8px 10px", marginBottom: 6, cursor: "pointer", fontSize: 12 }}>
            <b>{j.job_id}</b> · <span style={{ color: STATUS_COLOR[j.status] || "#101828", fontWeight: 700 }}>{j.status}</span> · {j.product?.name || "no product"}
            {j.merged?.ok ? " · merged ✓" : ""}{j.poster ? " · poster ✓" : ""}{j.render ? ` · render ${j.render.bytes} B` : " · no render"}
          </button>
        ))}
        {!jobs.length && <p style={{ fontSize: 12, color: "#8a93a3" }}>No commercial jobs yet.</p>}
      </section>

      {preview && (
        <MobileFrame url={current?.publish_target?.url || landing} title="Coffee-store commercial — campaign landing page" onClose={() => setPreview(false)}
          note="Preview only — nothing has been published. Publishing writes to this live public page and needs your explicit approval." />
      )}
    </div>
  );
}
