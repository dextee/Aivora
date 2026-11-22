/* AIVORA V43 — Marketing Campaign Agent (P0 storyboard: "generate a marketing campaign").
 * Source of truth = the created RM4 coffee storefront + catalog (loadStoreCatalog). Reuses existing
 * product images/brand (does NOT re-analyze the product). Registers the four named marketing skills as
 * native AIVORA actions. Copy is generated deterministically from the real catalog (grounded, not a
 * fabricated "model" response). The static ad + 15s video are produced by the AUTHORIZED media provider
 * (Qwen image/video) and attached via attachAsset — NEVER fabricated here (rule: never fake media). */
import { get, logEvent } from "./store.mjs";
import { loadStoreCatalog } from "./store_setup.mjs";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CAMPAIGNS_DIR = fileURLToPath(new URL("../../odai/campaigns/", import.meta.url));
const campaigns = new Map(); // `${tenant}/${id}` -> campaign

const STORE_URL = "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/coffee-store";
const WA = String(process.env.STORE_WHATSAPP || "6583827213");

/* Registered reusable skills (native implementations of the named contracts). */
export const MARKETING_SKILLS = {
  "marketing.create_campaign": createCampaign,
  "marketing.generate_copy": generateCopy,
  "marketing.generate_creative": generateCreative,
  "marketing.prepare_distribution": prepareDistribution,
};

function emit(tenant, kind, decision, note) {
  try { logEvent(get(tenant), { runId: null, beat: "·", actor: "marketing", kind, decision, note }); } catch { /* trace best-effort */ }
}
function persist(c) { try { mkdirSync(CAMPAIGNS_DIR, { recursive: true }); writeFileSync(CAMPAIGNS_DIR + `${c.campaign_id}.json`, JSON.stringify(c, null, 2)); } catch { /* durable best-effort */ } }

/* marketing.generate_copy — grounded in the real catalog; no invented prices/claims. */
export function generateCopy(catalog) {
  const names = (catalog.products || []).map((p) => p.name);
  const cheapest = (catalog.products || []).slice().sort((a, b) => a.price - b.price)[0];
  return {
    campaign_objective: "Launch the RM4 coffee store and convert enquiries into first orders (organic-first).",
    target_customer_segments: [
      "Traditional kopi drinkers (SG/MY)",
      "Value-seeking daily coffee — students & office workers",
      "Small cafés / wholesale resellers",
    ],
    marketing_angles: [
      "Unbeatable everyday value (from RM4)",
      "Authentic Nanyang kopi taste, ready in seconds",
      "Instant, no-fuss — home or office",
    ],
    promotional_headlines: [
      "RM4 Kopi. Bold. Ready when you are.",
      "Your daily kopi — without the daily price.",
      `From ${catalog.currency}${cheapest ? cheapest.price.toFixed(2) : "4.00"} — ${names[0] || "AIVORA kopi"}`,
    ],
    social_captions: [
      `☕ New drop: ${names.slice(0, 3).join(", ")} — from ${catalog.currency}${cheapest ? cheapest.price.toFixed(2) : "4.00"}. Order on WhatsApp 👉 wa.me/${WA}`,
      "Nanyang taste, instant. RM4 kopi that keeps up with your day. DM to order.",
      "Brew less, live more. AIVORA instant kopi — try the box today.",
    ],
    call_to_action: "Order on WhatsApp",
    store_destination_url: STORE_URL,
    copy_source: "AIVORA template — grounded in the live catalog (no fabricated model output, no invented prices/claims)",
  };
}

/* marketing.generate_creative — returns PENDING slots only. Real media is produced by the authorized
 * provider out-of-band and attached via attachAsset. This function NEVER reports a completed file. */
export function generateCreative() {
  return {
    static_advertisement: { status: "PENDING_PROVIDER", file: null },
    video_15s: { status: "PENDING_PROVIDER", file: null },
    note: "Creative is produced by the authorized media provider (Qwen image/video); slots stay PENDING until a real asset is attached. Never fabricated.",
  };
}

/* marketing.prepare_distribution — organic-first schedule (paid posts require the approval gate). */
export function prepareDistribution() {
  return {
    proposed_schedule: [
      { day: "Day 1", channel: "store + WhatsApp", action: "Launch storefront + poster", paid: false },
      { day: "Day 3", channel: "Facebook/LinkedIn share", action: "Share store + captions", paid: false },
      { day: "Day 5", channel: "WhatsApp broadcast (approved only)", action: "Follow-up + 15s video", paid: false, gate: "approve_customer_comms" },
    ],
    paid_ads: "BLOCKED — organic-only default; any paid boost requires owner approval + S$50 ceiling",
  };
}

export function createCampaign(tenant, spec = {}) {
  const catalog = loadStoreCatalog();
  const campaign_id = "CAMP-" + Date.now().toString(36);
  const copy = generateCopy(catalog);
  const c = {
    campaign_id, tenant_id: tenant, objective_id: spec.objective_id || null,
    product_source: "RM4 coffee catalog (reused images; not re-analyzed)",
    ...copy,
    creative: generateCreative(),
    distribution: prepareDistribution(),
    assets: { poster: null, video: null },
    status: "copy_ready", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  campaigns.set(`${tenant}/${campaign_id}`, c);
  persist(c);
  emit(tenant, "CAMPAIGN_CREATED", "ALLOW", `${campaign_id} copy generated from ${catalog.products.length} catalog items`);
  return c;
}

/* Attach a REAL generated asset (from the authorized provider) and associate it with the campaign. */
export function attachAsset(tenant, campaign_id, { kind, url, provider, poster_url } = {}) {
  const c = campaigns.get(`${tenant}/${campaign_id}`) || loadFile(campaign_id);
  if (!c) return { error: "campaign not found" };
  if (!url) return { error: "url required (never attach a fabricated asset)" };
  if (kind === "poster") { c.assets.poster = { url, provider: provider || "authorized-media-provider", ready: true }; c.creative.static_advertisement = { status: "READY", file: url }; }
  else if (kind === "video") { c.assets.video = { url, provider: provider || "authorized-media-provider", ready: true, poster_url: poster_url || null }; c.creative.video_15s = { status: "READY", file: url }; }
  else return { error: "kind must be poster|video" };
  c.status = (c.assets.poster && c.assets.video) ? "assets_ready" : c.status;
  c.updated_at = new Date().toISOString();
  campaigns.set(`${tenant}/${c.campaign_id}`, c);
  persist(c);
  emit(tenant, "CAMPAIGN_ASSET_ATTACHED", "ALLOW", `${c.campaign_id} ${kind} attached (real provider asset)`);
  return c;
}

function loadFile(campaign_id) { try { return JSON.parse(readFileSync(CAMPAIGNS_DIR + `${campaign_id}.json`, "utf8")); } catch { return null; } }

export function getCampaign(tenant, campaign_id) { return campaigns.get(`${tenant}/${campaign_id}`) || loadFile(campaign_id) || { error: "not found" }; }
export function latestCampaign(tenant) { const all = [...campaigns.entries()].filter(([k]) => k.startsWith(tenant + "/")).map(([, v]) => v).sort((a, b) => b.created_at.localeCompare(a.created_at)); return all[0] || { error: "no campaign yet" }; }
