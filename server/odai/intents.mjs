/* odai/intents.mjs — WO-10: business-intent registry served by the engine.
 * All intent data (labels, utterances, scoring keywords) lives in
 * odai/config/intents_registry.json. This module contains NO intent prose —
 * only structural token scoring. GET /api/odai/intents serves the registry
 * minus internal fields; POST /api/odai/intents/match returns the nearest
 * intent. Objective auto-launch happens ONLY when the caller explicitly
 * passes ?autocreate=true (owner gate WO-09); the default path has no side
 * effects and the shipped client never passes the flag.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGISTRY_URL = new URL("../../odai/config/intents_registry.json", import.meta.url);
const INTERNAL_FIELDS = new Set(["keywords"]);           // stripped from everything the browser sees
const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "do", "does",
  "for", "from", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "me", "my", "of", "on", "or", "our", "please", "she", "so", "that", "the", "them", "then",
  "there", "this", "to", "too", "up", "us", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "why", "will", "with", "you", "your"]);
const MIN_SCORE = 2;                                     // two distinct overlapping terms (or one phrase hit, or exact utterance) to count as a match

export function registry() {
  return JSON.parse(readFileSync(fileURLToPath(REGISTRY_URL), "utf8"));
}

export function publicIntent(intent) {
  const out = {};
  for (const [k, v] of Object.entries(intent)) if (!INTERNAL_FIELDS.has(k)) out[k] = v;
  return out;
}

export function publicIntents() {
  return registry().intents.map(publicIntent);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const terms = (s) => norm(s).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));

function scoreOne(qTokens, qNorm, intent) {
  if (qNorm && qNorm === norm(intent.utterance)) return { score: 100, exact: true };
  const vocab = new Set([...terms(intent.label), ...terms(intent.utterance), ...(intent.keywords || []).flatMap(terms)]);
  let score = qTokens.filter((t) => vocab.has(t)).length;
  for (const kw of intent.keywords || []) {
    const phrase = norm(kw);
    if (phrase && phrase.includes(" ") && qNorm.includes(phrase)) score += 2;
  }
  return { score, exact: false };
}

export function matchIntent(utterance) {
  const qNorm = norm(utterance);
  if (!qNorm) return { intent: null, score: 0 };
  const qTokens = terms(qNorm);
  let best = null;
  for (const intent of registry().intents) {
    const { score, exact } = scoreOne(qTokens, qNorm, intent);
    if (!best || score > best.score) best = { intent, score, exact };
  }
  if (!best || (!best.exact && best.score < MIN_SCORE)) return { intent: null, score: best ? best.score : 0 };
  return { intent: publicIntent(best.intent), score: best.score };
}
