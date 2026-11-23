/* Protected storefront + payment configuration (single source of truth).
 * HASHMETA_STORE_URL and PAYPAL_PAYMENT_URL are frozen application constants.
 * RogueAI Shield treats the payment destination as protected financial config:
 * AI agents cannot change it; any attempt is blocked and recorded as a persistent
 * incident. Merchant credentials are never exposed here or to the frontend.
 *
 * Payment status honesty: opening the PayPal link is NOT proof of payment.
 * Without independently verified payment evidence, status stays PAYMENT_PENDING.
 * Unverified payments are never counted as collected revenue or paid receipts.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { get, logEvent } from "./store.mjs";
import { ingestEvent } from "./inbox.mjs";

export const HASHMETA_STORE_URL = "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/zh/coffee-store";
/* Owner instruction 2026-11-23: generated coffee-store video/poster assets land on this page
 * (live Hashmeta page id 22, slug "campaign1"). It is an approved DESTINATION constant —
 * approving the destination is not approval to publish; publishing stays an explicit owner action. */
export const HASHMETA_CAMPAIGN_URL = "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/campaign1";
export const PAYPAL_PAYMENT_URL = "https://paypal.me/AntimosSG?locale.x=en_GB&COUNTY.X=SG";
Object.freeze({ HASHMETA_STORE_URL, HASHMETA_CAMPAIGN_URL, PAYPAL_PAYMENT_URL });

export const PAYMENT_STATUSES = ["PAYMENT_LINK_OPENED", "PAYMENT_PENDING", "PAYMENT_VERIFIED", "PAYMENT_FAILED", "PAYMENT_REFUNDED"];

const root = fileURLToPath(new URL("../../odai/payments/", import.meta.url));
import { createHash } from "node:crypto";
const hash = (t) => createHash("sha256").update(t).digest("hex");
function load(t) { try { return JSON.parse(readFileSync(root + hash(t) + ".json", "utf8")); } catch (e) { if (e.code === "ENOENT") return { payments: [], incidents: [] }; throw e; } }
function persist(t, s) { mkdirSync(root, { recursive: true }); const d = root + hash(t) + ".json", tmp = d + "." + randomUUID() + ".tmp"; writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); renameSync(tmp, d); }

/* Public, credential-free configuration for the frontend + all features. */
export function getStoreConfig() {
  return { store_url: HASHMETA_STORE_URL, campaign_landing_url: HASHMETA_CAMPAIGN_URL, paypal_url: PAYPAL_PAYMENT_URL, currency: "SGD", payment_statuses: PAYMENT_STATUSES, protected: true, note: "Storefront, campaign landing page and payment destination are protected constants; AI agents cannot alter them. Approving a destination is not approval to publish." };
}

/* RogueAI: enforce the exact approved payment destination. Any alternative is blocked. */
export function assertPaymentDestination(url) {
  return String(url || "") === PAYPAL_PAYMENT_URL;
}
export function attemptPaymentChange(tenant, { agent_id, proposed_url, proposed_store_url } = {}) {
  const s = load(tenant);
  const violations = [];
  if (proposed_url !== undefined && proposed_url !== PAYPAL_PAYMENT_URL) violations.push("payment_destination_manipulation");
  if (proposed_store_url !== undefined && proposed_store_url !== HASHMETA_STORE_URL) violations.push("unapproved_website_change");
  if (!violations.length) return { blocked: false, note: "No change attempted; approved constants intact." };
  const incident = { incident_id: "PAY-" + randomUUID().slice(0, 8), agent_id: agent_id || "unknown", violations, proposed_url: proposed_url || null, proposed_store_url: proposed_store_url || null, approved_paypal: PAYPAL_PAYMENT_URL, approved_store: HASHMETA_STORE_URL, ts: new Date().toISOString(), decision: "BLOCK" };
  s.incidents.push(incident);
  persist(tenant, s);
  const ev = { kind: "ROGUEAI_BLOCK", event_id: incident.incident_id, ts: incident.ts, actor: "guardrails", decision: "BLOCK" };
  try { logEvent(get(tenant), ev); ingestEvent(tenant, { ...ev, mode: "TEST_SIMULATED" }); } catch { /* best-effort */ }
  return { blocked: true, incident, preserved_paypal: PAYPAL_PAYMENT_URL, preserved_store: HASHMETA_STORE_URL, spoken: `Blocked: an agent tried to change the protected payment/store destination. The approved PayPal and storefront URLs are preserved; incident ${incident.incident_id} recorded.` };
}

/* Payment status lifecycle. Opening a link != payment. Verification needs evidence. */
export function recordPaymentEvent(tenant, { product_id, customer_id, action, evidence } = {}) {
  const s = load(tenant);
  const id = product_id || "general";
  let rec = s.payments.find((p) => p.product_id === id && (customer_id ? p.customer_id === customer_id : true));
  if (!rec) { rec = { payment_id: "pay-" + randomUUID().slice(0, 8), product_id: id, customer_id: customer_id || null, status: "PAYMENT_PENDING", amount: null, currency: "SGD", history: [], verified: false }; s.payments.push(rec); }
  const ts = new Date().toISOString();
  if (action === "open_link") {
    rec.status = "PAYMENT_LINK_OPENED";
    rec.history.push({ status: "PAYMENT_LINK_OPENED", ts });
    /* opening the link does not establish payment; settle to PENDING */
    rec.status = "PAYMENT_PENDING";
    rec.history.push({ status: "PAYMENT_PENDING", ts, note: "Link opened; payment not yet verified." });
  } else if (action === "verify") {
    if (evidence && evidence.verified === true && evidence.provider_reference) {
      rec.status = "PAYMENT_VERIFIED"; rec.verified = true; rec.provider_reference = evidence.provider_reference; rec.amount = evidence.amount ?? rec.amount;
      rec.history.push({ status: "PAYMENT_VERIFIED", ts, provider_reference: evidence.provider_reference });
    } else {
      rec.status = "PAYMENT_PENDING";
      rec.history.push({ status: "PAYMENT_PENDING", ts, note: "No independently verified payment evidence; remains pending." });
    }
  } else if (action === "fail") { rec.status = "PAYMENT_FAILED"; rec.history.push({ status: "PAYMENT_FAILED", ts }); }
  else if (action === "refund") { rec.status = "PAYMENT_REFUNDED"; rec.verified = false; rec.history.push({ status: "PAYMENT_REFUNDED", ts }); }
  else throw Object.assign(new Error("Unknown payment action"), { status: 400 });
  persist(tenant, s);
  return { ok: true, payment: rec, paid: rec.status === "PAYMENT_VERIFIED", note: rec.status === "PAYMENT_VERIFIED" ? "Payment verified against provider evidence." : "Not verified payment; not counted as collected revenue and no paid receipt issued." };
}

/* Only VERIFIED payments count as collected revenue (for Business Intelligence). */
export function verifiedRevenue(tenant) {
  const s = load(tenant);
  const verified = s.payments.filter((p) => p.status === "PAYMENT_VERIFIED");
  return { collected_revenue: verified.reduce((sum, p) => sum + (p.amount || 0), 0), currency: "SGD", verified_count: verified.length, pending_count: s.payments.filter((p) => p.status === "PAYMENT_PENDING").length, note: "Only independent provider-verified payments are counted; link opens and pending payments are excluded." };
}
export function paymentState(tenant) { const s = load(tenant); return { payments: s.payments, incidents: s.incidents, revenue: verifiedRevenue(tenant) }; }