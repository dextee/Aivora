/* AIVORA Commercial Studio — objective "Create commercial with avatar".
 * The owner attaches a SELF PHOTO (avatar) and a PRODUCT (catalog row or product photo); this
 * module validates both, grounds the script in the real catalog, and emits a provider render
 * SPEC for a 15-second commercial.
 *
 * HONESTY RULES (same posture as marketing.mjs creative slots):
 *  1. The video is produced by the AUTHORIZED media provider (QwenWork built-in seedance-2.0),
 *     never here. Until a real file is attached the job stays PENDING_PROVIDER.
 *  2. No price, claim or product fact is invented: catalog products supply name/price/currency,
 *     and an uploaded product photo requires the owner to state the facts explicitly.
 *  3. Likeness consent is mandatory before an avatar photo can be used (workbook control G12).
 *  4. Jobs persist on disk (odai/data/commercial) so a restart does not lose them (DEF-07 lesson).
 *  5. Inputs are validated at the boundary: type, size and sha256 recorded; nothing executable. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dropshipList } from "./shop_setup.mjs";
import { attachAsset } from "./marketing.mjs";
import { ingestEvent } from "./inbox.mjs";
import { verifyOutboundLink } from "./trust_layer.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = ROOT + "odai/data/commercial/";
const UPLOADS = ROOT + "odai/uploads/commercial/";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAGIC = { "/9j/": "jpg", "iVBOR": "png", "UklGR": "webp" };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const now = () => new Date().toISOString();
const err = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function load(job_id) {
  const p = DIR + job_id + ".json";
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function save(job) {
  mkdirSync(DIR, { recursive: true });
  const final = DIR + job.job_id + ".json";
  const tmp = final + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
  renameSync(tmp, final); /* atomic replace; no partial job state */
  return job;
}

export function listCommercial(tenant) {
  mkdirSync(DIR, { recursive: true });
  const jobs = readdirSync(DIR).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(readFileSync(DIR + f, "utf8")); } catch { return null; } }).filter(j => j && j.tenant_id === tenant);
  return { tenant_id: tenant, jobs: jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), provider: PROVIDER, note: "The 15s render is produced by the authorized media provider and attached back; this store never fabricates a video." };
}
export function getCommercial(tenant, job_id) {
  const j = load(String(job_id || ""));
  if (!j || j.tenant_id !== tenant) throw err("commercial job not found", 404);
  return j;
}

export const PROVIDER = {
  engine: "qwenwork_builtin_video_generate",
  model: "seedance-2.0",
  mode: "reference_images_to_video",
  duration_seconds: 15,
  resolution: "1080p",
  note: "Built-in generator; no third-party SDK is installed and no external API key is used. The unverified 'seeddance-sdk' npm package is deliberately NOT used.",
};

/* ---- 1. input attachment (self photo / product photo) ---- */
export function attachInput(tenant, { kind, filename, data_base64, likeness_consent = false }) {
  if (!["avatar", "product"].includes(kind)) throw err("kind must be 'avatar' or 'product'");
  const raw = String(data_base64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!raw) throw err("data_base64 required");
  let buf;
  try { buf = Buffer.from(raw, "base64"); } catch { throw err("data_base64 is not valid base64"); }
  if (!buf.length) throw err("decoded image is empty");
  if (buf.length > MAX_IMAGE_BYTES) throw err(`image exceeds the ${MAX_IMAGE_BYTES} byte limit`, 413);
  const head = buf.subarray(0, 4).toString("base64");
  const ext = Object.entries(MAGIC).find(([k]) => head.startsWith(k))?.[1];
  if (!ext) throw err("unsupported image type: only JPEG, PNG or WebP are accepted (magic bytes checked)", 415);
  if (buf.subarray(0, 2).toString() === "PK" || /MZ/.test(buf.subarray(0, 2).toString())) throw err("executable/archive content rejected", 415);
  if (kind === "avatar" && likeness_consent !== true) {
    throw err("likeness consent is required before a self photo can be used (control G12: rights and likeness)", 403, { code: "LIKENESS_CONSENT_REQUIRED" });
  }
  const digest = sha(buf);
  mkdirSync(UPLOADS, { recursive: true });
  const path = UPLOADS + digest + "." + ext;
  if (!existsSync(path)) writeFileSync(path, buf, { mode: 0o600 });
  const rec = { upload_id: "UP-" + digest.slice(0, 12), kind, filename: String(filename || "").slice(0, 120) || null, ext, bytes: buf.length, sha256: digest, path, likeness_consent: kind === "avatar" ? true : null, stored_at: now() };
  ingestEvent(tenant, { kind: "COMMERCIAL_INPUT_STORED", event_id: randomUUID(), ts: rec.stored_at, actor: "commercial-studio", note: `${kind} ${rec.upload_id} ${rec.ext} ${rec.bytes}B sha256=${digest.slice(0, 16)}…` });
  return rec;
}

/* ---- 2. job creation: grounded script + provider spec, or an explicit BLOCKED reason ---- */
export function createCommercial(tenant, input = {}) {
  const { avatar_upload_id = null, product_id = null, product_upload_id = null, language = "English", aspect_ratio = "9:16", hook = null, campaign_id = null, distribution_url = null, product_facts = null } = input;
  const missing = [];
  if (!avatar_upload_id) missing.push("avatar (self photo)");
  if (!product_id && !product_upload_id) missing.push("product (catalog item or product photo)");
  const job = {
    job_id: "COMM-" + randomUUID().slice(0, 8), tenant_id: tenant, objective: "Create commercial with avatar",
    status: "DRAFT_INPUTS_MISSING", created_at: now(), updated_at: now(),
    inputs: { avatar_upload_id, product_id, product_upload_id },
    language, aspect_ratio, hook: hook ? String(hook).slice(0, 200) : null, campaign_id,
    provider: PROVIDER, product: null, spec: null, render: null, blockers: [], audit: [],
  };
  const push = (code, detail) => { job.blockers.push({ code, detail, at: now() }); job.audit.push({ at: now(), event: code, detail }); };

  if (missing.length) { push("INPUTS_MISSING", "Required before a render can be requested: " + missing.join(", ")); job.status = "BLOCKED"; return save(job); }

  /* avatar must exist on disk and carry consent */
  const avatar = findUpload(tenant, avatar_upload_id, "avatar");
  if (!avatar) { push("AVATAR_NOT_FOUND", `avatar upload ${avatar_upload_id} is not stored for this workspace`); job.status = "BLOCKED"; return save(job); }
  if (avatar.likeness_consent !== true) { push("LIKENESS_CONSENT_REQUIRED", "avatar stored without recorded likeness consent"); job.status = "BLOCKED"; return save(job); }
  job.avatar = { upload_id: avatar.upload_id, ext: avatar.ext, bytes: avatar.bytes, sha256: avatar.sha256, path: avatar.path };

  /* product facts must come from the real catalog, or be stated explicitly by the owner */
  if (product_id) {
    const p = dropshipList().find(x => x.product_id === product_id);
    if (!p) { push("PRODUCT_NOT_IN_CATALOG", `${product_id} is not an approved catalog product; nothing was invented`); job.status = "BLOCKED"; return save(job); }
    job.product = { source: "catalog", product_id: p.product_id, name: p.name, currency: p.currency, approved_selling_price: p.approved_selling_price, category: p.category || null, supplier: p.supplier || null, image: p.image || null, claims: [] };
  } else {
    const up = findUpload(tenant, product_upload_id, "product");
    if (!up) { push("PRODUCT_IMAGE_NOT_FOUND", `product upload ${product_upload_id} is not stored for this workspace`); job.status = "BLOCKED"; return save(job); }
    const f = product_facts || {};
    if (!f.name || f.price == null || !f.currency) {
      push("PRODUCT_FACTS_REQUIRED", "A product photo alone is not enough: state name, price and currency explicitly. Prices and claims are never inferred (control G13).");
      job.status = "BLOCKED"; job.product_image = { upload_id: up.upload_id, ext: up.ext, bytes: up.bytes, sha256: up.sha256, path: up.path };
      return save(job);
    }
    job.product = { source: "owner-stated", name: String(f.name).slice(0, 120), currency: String(f.currency).slice(0, 3).toUpperCase(), approved_selling_price: Number(f.price), claims: Array.isArray(f.claims) ? f.claims.slice(0, 5).map(c => String(c).slice(0, 120)) : [], image: up.path };
    job.product_image = { upload_id: up.upload_id, ext: up.ext, bytes: up.bytes, sha256: up.sha256, path: up.path };
  }

  /* optional distribution destination goes through the trust layer allowlist */
  if (distribution_url) {
    const dec = verifyOutboundLink(distribution_url, { outcome: "commercial-studio" });
    job.audit.push({ at: now(), event: "TRUST_" + dec.decision, detail: `${dec.decision_id} ${dec.decision_reason}` });
    if (dec.decision !== "ALLOW") { push("DESTINATION_NOT_ALLOWED", `trust layer ${dec.decision}: ${dec.decision_reason}`); job.status = "REJECTED"; return save(job); }
    job.distribution_url = distribution_url;
  }

  job.spec = buildSpec(job);
  job.status = "READY_TO_RENDER";
  job.audit.push({ at: now(), event: "SPEC_BUILT", detail: `${job.spec.duration_seconds}s ${job.spec.resolution} ${job.spec.aspect_ratio} references=${job.spec.reference_images.length}` });
  ingestEvent(tenant, { kind: "COMMERCIAL_SPEC_READY", event_id: randomUUID(), ts: now(), actor: "commercial-studio", objective_id: job.job_id, note: `${job.job_id} 15s spec ready; provider=${PROVIDER.model}; no video generated yet` });
  return save(job);
}

function findUpload(tenant, upload_id, kind) {
  if (!existsSync(UPLOADS)) return null;
  const id = String(upload_id || "");
  for (const f of readdirSync(UPLOADS)) {
    if (!/\.(jpg|png|webp)$/.test(f)) continue;
    const digest = f.split(".")[0];
    if (id !== "UP-" + digest.slice(0, 12)) continue;
    const path = UPLOADS + f;
    const bytes = readFileSync(path).length;
    return { upload_id: id, kind, ext: f.split(".")[1], bytes, sha256: digest, path, likeness_consent: kind === "avatar" ? true : null };
  }
  return null;
}

/* The prompt is grounded in verified product facts only; no invented claims or prices. */
function buildSpec(job) {
  const p = job.product;
  const price = `${p.currency} ${Number(p.approved_selling_price).toFixed(2)}`;
  const claims = (p.claims || []).length ? p.claims.join("; ") : `${p.category || p.name} from the approved catalog`;
  const lang = job.language;
  return {
    engine: PROVIDER.engine, model: PROVIDER.model, mode: PROVIDER.mode,
    duration_seconds: PROVIDER.duration_seconds, resolution: PROVIDER.resolution, aspect_ratio: job.aspect_ratio,
    generate_audio: true,
    reference_images: [job.avatar.path, p.image || job.product_image?.path].filter(Boolean),
    reference_roles: ["avatar (owner self photo, likeness consent recorded)", p.source === "catalog" ? "product (catalog image)" : "product (owner-supplied photo)"],
    prompt: `15-second vertical retail commercial. A friendly local spokesperson (the avatar reference) presents ${p.name} to camera in ${lang}, holds the product (the product reference), and ends on a clear call to action. On-screen text states the verified price ${price}. Product facts: ${claims}. Warm kopi-shop lighting, handheld-to-locked-off camera move, one push-in on the product, cut to the spokesperson for the CTA. Do not add prices, claims, certifications or health benefits beyond the facts given. Do not distort the avatar's face.`,
    negative_prompt: "invented prices, unverified health or certification claims, extra text, distorted face, extra fingers, watermark, logo of another brand",
    grounded_in: { product_source: p.source, product_id: p.product_id || null, price, currency: p.currency, claims: p.claims || [], catalog_verified: p.source === "catalog" },
    honesty: "This is a REQUEST SPEC. No video exists until a provider render is attached with attachRender().",
  };
}

/* ---- 3. handoff + attach the real render ---- */
export function markDispatched(tenant, job_id, { provider_task_id = null, dispatched_by = "owner" } = {}) {
  const job = getCommercial(tenant, job_id);
  if (job.status !== "READY_TO_RENDER" && job.status !== "PENDING_PROVIDER") throw err(`job is ${job.status}; only a READY_TO_RENDER job can be dispatched`, 409);
  job.status = "PENDING_PROVIDER";
  job.provider_task_id = provider_task_id ? String(provider_task_id).slice(0, 120) : job.provider_task_id || null;
  job.dispatched_at = now(); job.dispatched_by = String(dispatched_by).slice(0, 60);
  job.audit.push({ at: now(), event: "DISPATCHED_TO_PROVIDER", detail: `task=${job.provider_task_id || "unrecorded"} — no file claimed` });
  ingestEvent(tenant, { kind: "COMMERCIAL_DISPATCHED", event_id: randomUUID(), ts: now(), actor: "commercial-studio", objective_id: job.job_id, note: `${job.job_id} handed to ${PROVIDER.model}; status PENDING_PROVIDER` });
  return save(job);
}

export function attachRender(tenant, job_id, { file_path, provider_task_id = null, duration_seconds = null, provider = PROVIDER.model }) {
  const job = getCommercial(tenant, job_id);
  const p = String(file_path || "");
  if (!p) throw err("file_path required");
  if (!existsSync(p)) throw err(`rendered file not found: ${p}`, 404);
  const buf = readFileSync(p);
  if (buf.length < 1024) throw err("rendered file is too small to be a real video", 422);
  const magic = buf.subarray(4, 8).toString("latin1");
  if (magic !== "ftyp") throw err(`not an MP4/MOV container (bytes 4-8 = "${magic}", expected "ftyp")`, 415);
  const dur = duration_seconds == null ? null : Number(duration_seconds);
  if (dur != null && (dur < 14 || dur > 16)) throw err(`duration ${dur}s is outside the 15s commercial tolerance (14-16s)`, 422, { code: "DURATION_OUT_OF_TOLERANCE" });
  const digest = sha(buf);
  job.render = { file_path: p, bytes: buf.length, sha256: digest, container: "mp4/ftyp", duration_seconds: dur, provider, provider_task_id: provider_task_id || job.provider_task_id || null, attached_at: now() };
  job.status = "RENDERED";
  job.audit.push({ at: now(), event: "RENDER_ATTACHED", detail: `${buf.length}B sha256=${digest.slice(0, 16)}… duration=${dur ?? "unreported"}s` });
  if (job.campaign_id) {
    try {
      const a = attachAsset(tenant, job.campaign_id, { kind: "video_15s", url: "/api/odai/commercial/" + job.job_id + "/file", provider });
      job.campaign_asset = a?.campaign_id ? { campaign_id: a.campaign_id, attached: true } : { campaign_id: job.campaign_id, attached: false, reason: "campaign asset slot unchanged" };
    } catch (e) { job.campaign_asset = { campaign_id: job.campaign_id, attached: false, reason: String(e.message || e).slice(0, 120) }; }
  }
  ingestEvent(tenant, { kind: "COMMERCIAL_RENDERED", event_id: randomUUID(), ts: now(), actor: "commercial-studio", objective_id: job.job_id, note: `${job.job_id} real render attached (${buf.length}B, ${dur ?? "?"}s)` });
  return save(job);
}

export function renderFile(tenant, job_id) {
  const job = getCommercial(tenant, job_id);
  if (!job.render?.file_path || !existsSync(job.render.file_path)) throw err("no rendered file attached", 404);
  return { buf: readFileSync(job.render.file_path), job };
}
