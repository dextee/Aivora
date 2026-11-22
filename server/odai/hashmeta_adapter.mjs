/* AIVORA V43 — Hashmeta Integration Adapter.
 * Reuses the existing hashmeta.mjs env/token convention (env.hashmetaToken, MCP_URL). Detects connectivity
 * mode: LIVE only when a HASHMETA_API_TOKEN is present; otherwise a clearly-labeled SANDBOX adapter with the
 * IDENTICAL internal skill interface. Never reports external publication unless the provider confirms it.
 *
 * Registered logical skills: hashmeta.create_campaign, hashmeta.upload_creative, hashmeta.prepare_publication,
 * hashmeta.get_campaign_status, hashmeta.get_campaign_metrics. prepare_publication enforces a HUMAN approval
 * checkpoint before any submit; paid ads stay BLOCKED (organic-only) per the existing gates. */
import { get, logEvent } from "./store.mjs";
import { latestCampaign } from "./marketing.mjs";
import { loadStoreCatalog } from "./store_setup.mjs";

const MCP_URL = process.env.HASHMETA_MCP_URL || "https://app.hashmeta.ai/api/mcp";
const records = new Map(); // tenant -> campaign record
const ref = (tenant) => `${tenant}/rm4-coffee-launch`;

const mode = (env) => (env && env.hashmetaToken ? "live" : "sandbox");
function audit(tenant, kind, decision, note) { try { logEvent(get(tenant), { runId: null, beat: "·", actor: "hashmeta", kind, decision, note }); } catch { /* best-effort */ } }
function need(tenant) { return records.get(ref(tenant)) || { error: "no hashmeta campaign — call create_campaign first" }; }

/* Map the AIVORA coffee campaign into the Hashmeta-supported payload (source of truth = marketing campaign + catalog). */
export function mapCampaign(tenant) {
  const camp = latestCampaign(tenant);
  if (camp.error) return camp;
  const catalog = loadStoreCatalog();
  return {
    campaign_name: "AIVORA RM4 Coffee Launch",
    product: "Premium Coffee",
    price: "MYR4",
    landing_page_url: camp.store_destination_url,
    approved_marketing_copy: { headlines: camp.promotional_headlines, captions: camp.social_captions, cta: camp.call_to_action },
    creative_assets: [
      camp.assets.poster && { kind: "poster", file: camp.assets.poster.url, provider: camp.assets.poster.provider },
      camp.assets.video && { kind: "video_15s", file: camp.assets.video.url, provider: camp.assets.video.provider },
    ].filter(Boolean),
    target_audience: camp.target_customer_segments,
    publication_schedule: camp.distribution.proposed_schedule,
    catalog_currency: catalog.currency,
    currency_note: "directive price MYR4; live catalog lists " + catalog.currency + " pricing — reconcile before real publication",
  };
}

function validate(p) {
  const errors = [];
  if (!p.campaign_name) errors.push("campaign_name");
  if (!/^https?:\/\//.test(p.landing_page_url || "")) errors.push("landing_page_url");
  if (!p.approved_marketing_copy || !p.approved_marketing_copy.headlines || !p.approved_marketing_copy.headlines.length) errors.push("approved_marketing_copy");
  if (!p.creative_assets || !p.creative_assets.length) errors.push("creative_assets");
  if (!p.target_audience || !p.target_audience.length) errors.push("target_audience");
  if (!p.publication_schedule || !p.publication_schedule.length) errors.push("publication_schedule");
  return { ok: errors.length === 0, errors };
}

/* hashmeta.create_campaign */
export function createCampaign(tenant, env) {
  const payload = mapCampaign(tenant);
  if (payload.error) return payload;
  const v = validate(payload);
  const rec = { campaign_ref: "HM-" + Date.now().toString(36), mode: mode(env), mcp_url: MCP_URL, payload, validation: v,
    lifecycle: "created", approval: "NOT_REQUESTED", uploaded_assets: null, provider_response: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  records.set(ref(tenant), rec);
  audit(tenant, "HASHMETA_CAMPAIGN_CREATED", v.ok ? "ALLOW" : "BLOCK", `mode=${rec.mode} valid=${v.ok}`);
  return rec;
}

/* hashmeta.upload_creative */
export function uploadCreative(tenant, env) {
  const r = need(tenant); if (r.error) return r;
  r.uploaded_assets = r.payload.creative_assets.map((a) => ({ kind: a.kind, file: a.file, status: r.mode === "sandbox" ? "SANDBOX_STAGED" : "PENDING_UPLOAD" }));
  r.lifecycle = "creative_uploaded"; r.updated_at = new Date().toISOString();
  audit(tenant, "HASHMETA_CREATIVE_UPLOADED", "ALLOW", `mode=${r.mode} assets=${r.uploaded_assets.length}`);
  return r;
}

/* hashmeta.prepare_publication — HUMAN APPROVAL CHECKPOINT (no auto publish, no spend). */
export function preparePublication(tenant, env) {
  const r = need(tenant); if (r.error) return r;
  if (!r.validation.ok) { r.lifecycle = "invalid"; return { ...r, error: "payload invalid — cannot prepare publication: " + r.validation.errors.join(",") }; }
  r.approval = "AWAITING_OWNER_APPROVAL"; r.lifecycle = "prepared_for_approval"; r.updated_at = new Date().toISOString();
  r.approval_checkpoint = { required: true, scopes: ["approve_publish", "approve_spend"], auto_publish: false, paid_ads: "BLOCKED (organic-only)", note: "Nothing publishes or spends until the owner explicitly approves." };
  audit(tenant, "HASHMETA_PREPARE_PUBLICATION", "NEVER", "awaiting owner approval; external write HELD");
  return r;
}

/* owner gate — required before submit */
export function approvePublication(tenant) {
  const r = need(tenant); if (r.error) return r;
  if (r.approval !== "AWAITING_OWNER_APPROVAL") return { ...r, error: "nothing awaiting approval" };
  r.approval = "APPROVED_BY_OWNER"; r.updated_at = new Date().toISOString();
  audit(tenant, "HASHMETA_PUBLICATION_APPROVED", "ALLOW", "owner approved publication");
  return r;
}

/* submission lifecycle — LIVE only with token + approval; otherwise labeled SANDBOX (never claims real publication). */
export function submit(tenant, env) {
  const r = need(tenant); if (r.error) return r;
  if (r.approval !== "APPROVED_BY_OWNER") return { ...r, error: "blocked: human approval required before submission/publication", external_effects: "NEVER_ATTEMPTED" };
  if (r.mode === "live") {
    r.provider_response = { provider: "hashmeta-live", status: "SUBMITTED", confirmed_publication: false, note: "live path requires HASHMETA_API_TOKEN + the hashmeta.mjs MCP client; not exercised in this run" };
    r.lifecycle = "submitted_live";
  } else {
    r.provider_response = { provider: "hashmeta-SANDBOX", status: "SANDBOX_SUBMITTED", request_id: "SBX-" + Date.now().toString(36), confirmed_publication: false, external_effects: "NONE_LOCAL_ONLY", note: "LOCAL simulated lifecycle — NOT a real external publication." };
    r.lifecycle = "submitted_sandbox";
  }
  r.updated_at = new Date().toISOString();
  audit(tenant, "HASHMETA_SUBMIT", "ALLOW", `mode=${r.mode} confirmed_publication=${!!r.provider_response.confirmed_publication}`);
  return r;
}

/* hashmeta.get_campaign_status */
export function getCampaignStatus(tenant) {
  const r = need(tenant); if (r.error) return r;
  return { campaign_ref: r.campaign_ref, connectivity_mode: r.mode, lifecycle: r.lifecycle, approval: r.approval,
    external_effects: r.mode === "sandbox" ? "NONE_LOCAL_ONLY" : "REQUIRES_LIVE", confirmed_publication: !!(r.provider_response && r.provider_response.confirmed_publication), provider_response: r.provider_response };
}

/* hashmeta.get_campaign_metrics */
export function getCampaignMetrics(tenant) {
  const r = need(tenant); if (r.error) return r;
  return { campaign_ref: r.campaign_ref, connectivity_mode: r.mode,
    metrics: r.mode === "sandbox" ? { impressions: 0, clicks: 0, orders: 0, note: "no live provider — sandbox metrics are zero and are never fabricated" } : { note: "live metrics require the provider API" } };
}

export function getRecord(tenant) { return need(tenant); }
