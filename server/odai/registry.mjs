/* odai/registry.mjs — WO-110/WO-102 business-plane registry READ layer (batch A1).
 * Registry is DATA (odai/config/*.json built by tools/build_registry.py from the
 * owner-workbook intake). No dispatcher, policy evaluator or planner is created or
 * modified here (G1-safe). CTRL-05 shim = matchObjective; CTRL-03 shim = criterionFromText.
 * Deterministic lexical + template scoring — NO LLM anywhere in this module.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const CONFIG_DIR = new URL("../../odai/config/", import.meta.url).pathname;
const FILES = ["business_agents.json", "specialist_roles.json", "skill_contracts.json",
  "objectives_registry.json", "task_graph.json", "connectors_matrix.json", "policy_index.json"];

/* fresh read per call, memoized per (path, bytes) so identical file content never re-parses */
const memo = new Map();
function load(name) {
  const raw = readFileSync(path.join(CONFIG_DIR, name));
  const digest = createHash("sha256").update(raw).digest("hex");
  const hit = memo.get(name);
  if (hit && hit.digest === digest) return hit.value;
  const value = JSON.parse(raw.toString("utf8"));
  memo.set(name, { digest, value });
  return value;
}

/* ---------- WO-102 generalized criterion grammar (Python mirror: build_registry.py
 * criterion_from_text; parity fixtures in tests/registry.test.mjs) ----------
 * Precedence: units_sold -> growth% -> RM cap -> RM revenue target -> RM amount
 * -> generic count -> date deadline. Legacy engine grammars stay authored in
 * objectives.mjs#interpret and are UNCHANGED; this grammar only ADDS kinds. */
const num = (s) => parseInt(String(s).replace(/,/g, ""), 10);
export function criterionFromText(text) {
  const t = String(text || "").replace(/\u2019/g, "'");
  let m;
  if ((m = t.match(/(\d+)(?:\s+\w+){0,4}\s*(?:units?|products?|pieces?|pcs)/i))) return { kind: "units_sold", target_units: num(m[1]) };
  const pct = t.match(/(\d+)\s*%/);
  const days = t.match(/(\d+)\s*(?:days?|hours?)/i);
  if (pct && days) return { kind: "growth", pct: num(pct[1]), days: num(days[1]) };
  m = t.match(/(?:no|not|don'?t|never)\s+more\s+than\s+RM\s?([\d,]+)/i);
  if (!m) m = t.match(/RM\s?([\d,]+)\s*(?:hard\s*)?(?:cap|limit)/i);
  if (!m) m = t.match(/(?:budget|spend|cost)s?\b[^.?]{0,24}?\bRM\s?([\d,]+)/i);
  if (m) return { kind: "money_cap_myr", cap_myr: num(m[1]) };
  if ((m = t.match(/(?:earn|make|generate|revenue of?)\s+(?:me\s+)?RM\s?([\d,]+)/i))) return { kind: "revenue_target_myr", target_myr: num(m[1]) };
  if (!/\bcap\b|\blimit\b/i.test(t) && (m = t.match(/RM\s?([\d,]+)/i))) return { kind: "money_amount_myr", amount_myr: num(m[1]) };
  if ((m = t.match(/(\d+)\s+((?:new\s+)?(?:customers?|orders?|leads?|followers?|subscribers?|reviews?|replies?|tickets?|abandoned carts?))/i))) return { kind: "count_target", target: num(m[1]), metric: m[2].toLowerCase().replace(/\s+/g, "_").replace(/s$/, "") };
  if ((m = t.match(/by\s+(?:the\s+)?(?:end\s+of\s+)?(this\s+week|this\s+month|this\s+quarter|this\s+year|next\s+week|next\s+month|next\s+year|(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i))) return { kind: "deadline", until: m[1].replace(/\s+/g, " ").toLowerCase() };
  return null;
}

/* ---------- deterministic lexical + template scoring (CTRL-05 shim) ---------- */
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "my", "me", "i", "we", "you", "your", "of", "to", "for", "on", "in", "is", "are", "do", "does", "can", "could", "would", "want", "please", "with", "that", "this", "it", "be", "at", "as", "s", "will", "about", "so", "how", "what", "am"]);
const normalize = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, "'").replace(/[^\p{L}\p{N}%.\- ]+/gu, " ");
const contentTokens = (s) => normalize(s).split(/\s+/).filter((w) => w && !STOPWORDS.has(w) && !/^[.\-]+$/.test(w));

function scoreOne(query, row) {
  const q = contentTokens(query);
  const r = contentTokens(row.statement);
  if (!q.length || !r.length) return { score: 0, coverage: 0, exact: false };
  const qs = new Set(q); const rs = new Set(r);
  if (qs.size === rs.size && [...qs].every((w) => rs.has(w))) return { score: 100, coverage: 1, exact: true }; // exact content match
  let overlap = 0;
  for (const w of qs) if (rs.has(w)) overlap++;
  const coverage = overlap / qs.size;
  const jaccard = overlap / (qs.size + rs.size - overlap);
  let score = coverage * 6 + jaccard * 6;
  // template scoring: criterion-kind coherence between incoming text and registry row
  const a = criterionFromText(query); const b = criterionFromText(row.statement);
  if (a && b && a.kind === b.kind) { score += 2; const ka = Object.keys(a)[1]; if (ka && a[ka] === b[ka]) score += 1; }
  return { score: Math.round(score * 100) / 100, coverage: Math.round(coverage * 1000) / 1000, exact: false };
}

/* Routing guard (additive safety): a statement only leaves the generic planner when
 *   (a) exact content match, or
 *   (b) score >= MIN_MATCH AND lexical coverage >= MIN_COVERAGE.
 * MIN_COVERAGE 0.45 keeps every V38/demo/intent-template phrasing (tested) on the
 * generic path — the registry takes only genuinely registry-shaped statements. */
export const MIN_MATCH = 7;
export const MIN_COVERAGE = 0.45;

export function matchObjective(statement) {
  const rows = load("objectives_registry.json").rows;
  let best = null; let bestScore = 0; let tie = false;
  for (const row of rows) {
    const res = scoreOne(statement, row);
    if (!(res.exact || (res.score >= MIN_MATCH && res.coverage >= MIN_COVERAGE))) continue;
    if (res.score > bestScore) { best = { objective: row, score: res.score, exact: res.exact }; bestScore = res.score; tie = false; }
    else if (res.score === bestScore) tie = true; // deterministic: ties refuse (fall back)
  }
  if (!best || tie) return null;
  return best;
}

/* ---------- plan expansion (CTRL-04/05 projection) + pre-dispatch edge validation ---------- */
export function validatePlanEdges(nodes) {
  const nodeId = (n) => n.id || n.task_id;
  const ids = new Set(nodes.map(nodeId));
  const pos = new Map(nodes.map((n, i) => [nodeId(n), i]));
  for (const n of nodes) {
    for (const p of n.depends_on || []) {
      if (!ids.has(p)) return { ok: false, error: `dependency ${p} outside plan ${nodeId(n)}` };
      if (pos.get(p) >= pos.get(nodeId(n))) return { ok: false, error: `dependency ${p} not topo-before ${nodeId(n)}` };
    }
  }
  return { ok: true };
}

export function planFor(registryObjectiveId) {
  const obj = load("objectives_registry.json").rows.find((r) => r.objective_id === registryObjectiveId);
  if (!obj) return null;
  const graph = load("task_graph.json").rows;
  const skills = new Map(load("skill_contracts.json").rows.map((s) => [s.skill_id, s]));
  const agents = new Map(load("business_agents.json").rows.map((a) => [a.agent_id, a]));
  const connectors = load("connectors_matrix.json").rows;
  const nodes = graph.filter((g) => g.objective_id === registryObjectiveId)
    .sort((a, b) => a.step - b.step || a.task_id.localeCompare(b.task_id))
    .map((g) => {
      const sk = skills.get(g.skill_id) || {};
      const impl = sk.implementation || {};
      const connectorClass = classifyCandidate(g.connector_candidate, connectors);
      const executable = impl.status === "IMPLEMENTED_P0" && (connectorClass === "MOCK" || connectorClass === "LOCAL");
      const node = {
        id: g.task_id, step: g.step, skill_id: g.skill_id, skill_key: sk.skill_key || null,
        agent_id: g.agent_id, agent_name: (agents.get(g.agent_id) || {}).agent_name || null,
        specialist: g.specialist, canonical_owner: sk.canonical_owner || g.canonical_owner,
        inputs: g.inputs, outputs: g.outputs, depends_on: g.depends_on,
        coverage: sk.coverage_dev02 || null, connector_candidate: g.connector_candidate,
        connector_class: connectorClass, module: impl.module || null, fn: impl.function || null,
        state: "planned", executable,
        blocked_reason: executable ? null
          : impl.status !== "IMPLEMENTED_P0" ? "SKILL_NOT_IMPLEMENTED"
          : connectorClass === "BLOCKED" ? "CONNECTOR_BLOCKED" : "CONNECTOR_NOT_SANDBOXED",
      };
      if (node.step === 1 && node.depends_on.length === 0) node.state = executable ? "ready" : "blocked_plan_validated";
      return node;
    });
  const edges = validatePlanEdges(nodes);
  if (!edges.ok) return { error: "task plan dependency validation failed: " + edges.error };
  const gates = obj.gates_mapped.map((g, i) => ({ ...g, index: i + 1, state: g.scope === "spend" ? "awaiting_owner" : g.scope === "review" ? "advisory_recorded" : "awaiting_owner_held_never" }));
  return {
    registry_objective_id: registryObjectiveId, business_family: obj.business_family,
    statement: obj.statement, criterion_spec: obj.criterion_spec, gates, tasks: nodes,
    edges_validated: true, measurable_via: obj.measurable_via,
    acceptance: obj.acceptance, lead_agent_id: obj.agent_id, priority: obj.priority,
  };
}

export function classifyCandidate(candidate, connectors) {
  const c = String(candidate || "").trim();
  if (!c || c === "None") return "LOCAL";
  if (/internal ledger/i.test(c)) return "LOCAL"; // WO-104 module ledger.mjs backs money skills
  if (/^internal$/i.test(c)) return "LOCAL";
  if (/TBD|not established/i.test(c)) return "BLOCKED";
  const name = c.replace(/\s+via\s+SK-\d+.*$/i, "").trim();
  for (const row of connectors) {
    if (String(row.provider).toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(String(row.provider).toLowerCase())) return row.classification;
  }
  return "PROVIDER_SANDBOX";
}

/* ---------- GET /api/odai/registry summary (counts + version hash) ---------- */
export function registrySummary() {
  const digests = {};
  let acc = createHash("sha256");
  for (const name of FILES) {
    const raw = readFileSync(path.join(CONFIG_DIR, name));
    const digest = createHash("sha256").update(raw).digest("hex");
    digests[name] = digest;
    acc.update(name + ":").update(digest).update("\n");
  }
  const objectives = load("objectives_registry.json");
  const skills = load("skill_contracts.json");
  const agents = load("business_agents.json");
  const specialists = load("specialist_roles.json");
  const tasks = load("task_graph.json");
  const connectors = load("connectors_matrix.json");
  const policies = load("policy_index.json");
  const p0 = Object.entries(skills.rows.reduce((m, r) => r.implementation?.status === "IMPLEMENTED_P0" ? (m[r.implementation.family] = r.skill_id, m) : m, {}));
  return {
    registry_version: objectives.registry_version,
    intake_sha256: objectives.intake_sha256,
    counts: {
      agents: agents.row_count, specialists: specialists.row_count, skills: skills.row_count,
      objectives: objectives.row_count, tasks: tasks.row_count, task_edges: tasks.edges,
      connectors: connectors.row_count, policies: policies.row_count,
    },
    connector_classification_totals: connectors.classification_totals,
    specialist_dedup_totals: specialists.dedup_ledger.final_totals,
    p0_skill_modules: p0.map(([family, skill_id]) => ({ family, skill_id })),
    version_hash: acc.digest("hex"),
    per_file_sha256: digests,
  };
}

/* contract row lookup used by skills.mjs self-audit (sheet-04 columns, odai/config only) */
export function loadSkillContract(family) {
  const row = load("skill_contracts.json").rows.find((r) => r.implementation && r.implementation.family === family);
  return row ? { skill_id: row.skill_id, required_input_fields: row.required_input_fields, required_output_fields: row.required_output_fields } : null;
}
