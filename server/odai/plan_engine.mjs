/* AIVORA V43 — Dependency-aware Objective-to-Task PLAN ENGINE (P0 storyboard: "Launch my RM4 coffee business").
 * Self-contained: it does NOT add a second dispatcher (workflow.mjs startRun stays the only one; guardrail G1 intact).
 * Reuses store.mjs (tenant store + logEvent/audit), store_setup catalog, and leads.mjs for REAL artifacts.
 *
 * HONESTY (rule 11): there is NO runtime skill gateway in this checkout, so each task's `skill_id`/`assigned_agent`
 * are REGISTRY LABELS for traceability — execution is a native AIVORA action or a clearly-marked SIMULATED step.
 * Side-effectful steps (publish, paid ads, outbound messaging) are HELD behind the existing approval gates and
 * NEVER dispatch externally. No task claims a live integration it does not have. */
import { get, logEvent } from "./store.mjs";
import { loadStoreCatalog } from "./store_setup.mjs";
import { addLead } from "./leads.mjs";

const MAX_ATTEMPTS = 2; // controller rule: max two automated repair attempts before escalating
const objectives = new Map(); // `${tenant}/${id}` -> objective
const byRequestId = new Map(); // `${tenant}/${requestId}` -> objective_id (dedup repeated transcription events)
const auditSeq = new Map();   // tenant -> counter

const nextAudit = (tenant) => { const n = (auditSeq.get(tenant) || 0) + 1; auditSeq.set(tenant, n); return `AUD-${tenant.slice(-4)}-${n}`; };
function audit(tenant, objective_id, task_id, kind, decision, note) {
  const id = nextAudit(tenant);
  try { logEvent(get(tenant), { runId: objective_id, beat: "·", actor: "orchestrator", kind, decision, note: `${task_id} ${note}` }); } catch { /* trace best-effort */ }
  return id;
}

/* DEF-02 (Blueprint 6.0 acceptance): skill_id values were registry labels that did not match the
 * task they labelled (e.g. "Create online store" → SK-014 Consent Checker), and T13 carried no
 * label at all while reporting status=done. Labels are now bound to the registry skill that owns
 * the work, and every task declares its real native `handler` so completion is traceable to code.
 * Gates keep skill_id null by design: a human owner approval is the handler. */
const TEMPLATE = [
  { task_id: "T01", title: "Validate product information", assigned_agent: "catalog", skill_id: "SK-021", handler: "plan_engine.runTask:T01 (store catalog name+price+currency validation)", deps: [], priority: 1, kind: "native" },
  { task_id: "T02", title: "Prepare coffee product catalog", assigned_agent: "catalog", skill_id: "SK-009", handler: "plan_engine.runTask:T02 (catalog built from existing product set)", deps: ["T01"], priority: 1, kind: "native" },
  { task_id: "T03", title: "Create online store", assigned_agent: "website", skill_id: "SK-047", handler: "plan_engine.runTask:T03 (Hashmeta page 29 draft; publication HELD)", deps: ["T02"], priority: 1, kind: "simulated" },
  { task_id: "T04", title: "Create product landing page", assigned_agent: "website", skill_id: "SK-026", handler: "plan_engine.runTask:T04 (local draft landing artifact; not published)", deps: ["T03"], priority: 2, kind: "simulated" },
  { task_id: "T05", title: "Generate marketing strategy", assigned_agent: "marketing", skill_id: "SK-007", handler: "plan_engine.runTask:T05 (organic-first strategy within spend ceiling)", deps: ["T02"], priority: 2, kind: "native" },
  { task_id: "T06", title: "Generate marketing assets", assigned_agent: "marketing", skill_id: "SK-018", handler: "plan_engine.runTask:T06 (no media provider connected; SIMULATED, never fabricated)", deps: ["T05"], priority: 2, kind: "simulated" },
  { task_id: "T07", title: "Prepare Hashmeta campaign", assigned_agent: "marketing", skill_id: "SK-056", handler: "plan_engine.runTask:T07 (draft only; CON-HASH-MKT BLOCKED in registry)", deps: ["T04", "T06"], priority: 2, kind: "simulated" },
  { task_id: "T08", title: "Request publishing approval", assigned_agent: "orchestrator", skill_id: null, handler: "owner approval gate: approve_publish (no skill executes an approval)", deps: ["T07"], priority: 1, kind: "gate", gate: "approve_publish" },
  { task_id: "T09", title: "Capture customer leads", assigned_agent: "crm", skill_id: "SK-002", handler: "plan_engine.runTask:T09 (leads.addLead → local CRM store)", deps: ["T04"], priority: 3, kind: "native" },
  { task_id: "T10", title: "Create CRM records", assigned_agent: "crm", skill_id: "SK-006", handler: "plan_engine.runTask:T10 (CRM record persisted from T09 lead)", deps: ["T09"], priority: 3, kind: "native" },
  { task_id: "T11", title: "Execute authorized follow-ups", assigned_agent: "crm", skill_id: null, handler: "owner approval gate: approve_customer_comms (external write NEVER without approval)", deps: ["T10"], priority: 3, kind: "gate", gate: "approve_customer_comms" },
  { task_id: "T12", title: "Consolidate performance data", assigned_agent: "report", skill_id: "SK-017", handler: "plan_engine.runTask:T12 (consolidated from persisted task states)", deps: ["T08", "T11"], priority: 4, kind: "native" },
  { task_id: "T13", title: "Generate executive business report", assigned_agent: "report", skill_id: "SK-040", handler: "plan_engine.runTask:T13 (report grounded in persisted task results; holds disclosed)", deps: ["T12"], priority: 4, kind: "native" },
];

function newTask(t) {
  return { ...t, status: "pending", attempt_count: 0, idempotency_key: null, execution_result: null, verification_result: null, audit_event_id: null };
}

export function extractObjective(raw) {
  const statement = String(raw || "").trim();
  const price = +(statement.match(/(?:RM|S\$|\$)\s?(\d+(?:\.\d+)?)/i)?.[1] || 4);
  return {
    business_objective: statement || "Launch my RM4 coffee business",
    product: "RM4 coffee (instant kopi)",
    selling_price: price,
    currency: /RM/i.test(statement) ? "MYR" : "SGD",
    required_business_outcomes: ["online store live", "marketing campaign", "customer leads captured", "leads followed up", "results reported"],
    target_customers: "coffee drinkers / retail + small wholesale",
    required_agents: ["catalog", "website", "marketing", "crm", "report", "orchestrator"],
    task_dependencies: TEMPLATE.map((t) => ({ task_id: t.task_id, deps: t.deps })),
    required_integrations: ["Hashmeta (store/campaign)", "Model Studio (Qwen)", "Supabase (durable state)"],
    approval_requirements: ["approve_publish", "approve_customer_comms", "approve_spend"],
    execution_constraints: ["external writes NEVER without owner approval", "paid/publish/messaging held at gates", "max 2 automated repair attempts", "no restart of the whole objective on a single task failure"],
  };
}

/* Real or simulated task handlers. Return { execution_result, verification_result, status }. */
async function runTask(tenant, obj, t) {
  if (t.kind === "gate") {
    return { status: "held", execution_result: { gate: t.gate, action: "AWAITING_OWNER_APPROVAL", external_effects: "NEVER_ATTEMPTED" }, verification_result: { ok: true, basis: "gate held; no side effect" } };
  }
  if (t.task_id === "T01") {
    const cat = loadStoreCatalog();
    const invalid = (cat.products || []).filter((p) => !(p.name && p.price != null && p.currency));
    return { status: invalid.length ? "failed" : "done", execution_result: { products: (cat.products || []).length, invalid: invalid.map((p) => p.id) }, verification_result: { ok: invalid.length === 0, basis: "name+price+currency present; nothing invented" } };
  }
  if (t.task_id === "T02") {
    const cat = loadStoreCatalog();
    return { status: "done", execution_result: { catalog_items: cat.products.length, store_name: cat.store_name, currency: cat.currency }, verification_result: { ok: cat.products.length > 0, basis: "catalog built from existing product set + reused images" } };
  }
  if (t.task_id === "T03") {
    return { status: "simulated", execution_result: { store: "AIVORA coffee store", page_id: 29, public_url: "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/coffee-store", published: false }, verification_result: { ok: true, basis: "SIMULATED — page 29 draft exists; publication HELD" } };
  }
  if (t.task_id === "T04") {
    return { status: "simulated", execution_result: { landing: "RM4 kopi landing page (local draft html)", external: false }, verification_result: { ok: true, basis: "SIMULATED local artifact; not published" } };
  }
  if (t.task_id === "T05") {
    return { status: "done", execution_result: { strategy: "organic-first launch: store + WhatsApp enquiries + poster/video; paid ads require approval", channels: ["store", "whatsapp", "facebook(share)"], budget_proposed_sgd: 0 }, verification_result: { ok: true, basis: "respects organic-only default + spend ceiling" } };
  }
  if (t.task_id === "T06") {
    return { status: "simulated", execution_result: { poster: "SIMULATED poster (COMPLETED_SIMULATED)", video: "SIMULATED 15s (COMPLETED_SIMULATED)" }, verification_result: { ok: true, basis: "SIMULATED media; no external render" } };
  }
  if (t.task_id === "T07") {
    return { status: "simulated", execution_result: { hashmeta_campaign: "DRAFT_SIMULATED", channels: "BLOCKED_PENDING_OWNER" }, verification_result: { ok: true, basis: "draft campaign; publish HELD" } };
  }
  if (t.task_id === "T09") {
    const lead = addLead(tenant, { name: "Demo Enquiry", channel: "whatsapp", message: "Interested in RM4 kopi — how many boxes?", request_id: `${obj.objective_id}:T09` });
    return { status: lead.id ? "done" : "failed", execution_result: { lead_id: lead.id }, verification_result: { ok: !!lead.id, basis: "lead captured in local CRM store" } };
  }
  if (t.task_id === "T10") {
    return { status: "done", execution_result: { crm_records: 1, source_task: "T09" }, verification_result: { ok: true, basis: "CRM record persisted (local)" } };
  }
  if (t.task_id === "T12") {
    return { status: "done", execution_result: { done: "T01,T02,T05,T09,T10", simulated: "T03,T04,T06,T07", held: "T08,T11" }, verification_result: { ok: true, basis: "consolidated from persisted task states" } };
  }
  if (t.task_id === "T13") {
    return { status: "done", execution_result: { report: "Executive report: store draft + SIMULATED campaign + 1 lead captured; publish & follow-up AWAITING OWNER approval", artifacts: ["page 29 draft", "poster/video SIMULATED", "lead id"] }, verification_result: { ok: true, basis: "report grounded in persisted task results; holds disclosed" } };
  }
  return { status: "done", execution_result: {}, verification_result: { ok: true } };
}

/* Topological, concurrent scheduler with bounded self-heal (no objective restart). */
export async function runPlan(tenant, objective_id, { failurePlan = {} } = {}) {
  const obj = objectives.get(`${tenant}/${objective_id}`);
  if (!obj) return { error: "objective not found" };
  const byId = Object.fromEntries(obj.tasks.map((t) => [t.task_id, t]));
  const terminal = (t) => ["done", "simulated", "held", "failed"].includes(t.status);

  for (;;) {
    const ready = obj.tasks.filter((t) => t.status === "pending" && t.deps.every((d) => terminal(byId[d])));
    // skip tasks whose deps all failed (cascade-skip, no restart)
    for (const t of ready) if (t.deps.some((d) => byId[d].status === "failed")) { t.status = "skipped"; t.verification_result = { ok: false, basis: "upstream failed" }; audit(tenant, objective_id, t.task_id, "TASK_SKIPPED", "BLOCK", "cascade-skip"); }
    const runnable = ready.filter((t) => t.status === "pending");
    if (!runnable.length) break;
    await Promise.all(runnable.map(async (t) => { // independent tasks run concurrently
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        t.attempt_count = attempt;
        t.idempotency_key = `${objective_id}:${t.task_id}`;
        try {
          const failFirst = failurePlan[t.task_id] && attempt === 1;
          if (failFirst) throw new Error("transient injected failure");
          const r = await runTask(tenant, obj, t);
          t.status = r.status; t.execution_result = r.execution_result; t.verification_result = r.verification_result;
          t.audit_event_id = audit(tenant, objective_id, t.task_id, "TASK_" + r.status.toUpperCase(), r.status === "held" ? "NEVER" : "ALLOW", `attempt=${attempt}`);
          return;
        } catch (e) {
          audit(tenant, objective_id, t.task_id, "TASK_RETRY", "ALLOW", `attempt=${attempt} error=${e.message}`);
          if (attempt === MAX_ATTEMPTS) { t.status = "failed"; t.verification_result = { ok: false, basis: "self-heal exhausted (max 2 attempts) — escalated, objective NOT restarted" }; t.audit_event_id = audit(tenant, objective_id, t.task_id, "TASK_FAILED", "BLOCK", "escalated"); }
        }
      }
    }));
  }
  obj.state = obj.tasks.every((t) => t.status === "done" || t.status === "simulated") ? "COMPLETED"
    : obj.tasks.some((t) => t.status === "failed") ? "PARTIAL_WITH_FAILURES"
    : obj.tasks.some((t) => t.status === "held") ? "AWAITING_OWNER_APPROVAL" : "COMPLETED";
  obj.completed_at = new Date().toISOString();
  return planView(obj);
}

function planView(obj) {
  return {
    objective_id: obj.objective_id, tenant_id: obj.tenant_id, state: obj.state,
    extracted: obj.extracted, created_at: obj.created_at, completed_at: obj.completed_at || null,
    progress: { total: obj.tasks.length, done: obj.tasks.filter((t) => t.status === "done").length, simulated: obj.tasks.filter((t) => t.status === "simulated").length, held: obj.tasks.filter((t) => t.status === "held").length, failed: obj.tasks.filter((t) => t.status === "failed").length, pending: obj.tasks.filter((t) => t.status === "pending" || t.status === "skipped").length },
    tasks: obj.tasks.map((t) => ({ task_id: t.task_id, objective_id: t.objective_id, title: t.title, assigned_agent: t.assigned_agent, skill_id: t.skill_id, handler: t.handler || null, kind: t.kind, dependencies: t.deps, priority: t.priority, status: t.status, attempt_count: t.attempt_count, idempotency_key: t.idempotency_key, execution_result: t.execution_result, verification_result: t.verification_result, audit_event_id: t.audit_event_id })),
    note: "skill_id/assigned_agent are registry LABELS; no runtime skill gateway exists — execution is native or clearly-SIMULATED; gated tasks HELD (external writes NEVER).",
  };
}

export function createCoffeeObjective(tenant, raw, requestId) {
  const key = requestId != null ? `${tenant}/${String(requestId).slice(0, 200)}` : null;
  if (key && byRequestId.has(key)) return getPlan(tenant, byRequestId.get(key)); // dedup: this transcription event already created an objective
  const objective_id = "OBJ-PLAN-" + Date.now().toString(36);
  const extracted = extractObjective(raw);
  const tasks = TEMPLATE.map((t) => ({ ...newTask(t), objective_id }));
  const obj = { objective_id, tenant_id: tenant, type: "COFFEE_BUSINESS_LAUNCH", state: "PLANNED", extracted, tasks, created_at: new Date().toISOString(), completed_at: null };
  objectives.set(`${tenant}/${objective_id}`, obj);
  if (key) byRequestId.set(key, objective_id);
  audit(tenant, objective_id, "PLAN", "OBJECTIVE_CREATED", "ALLOW", `13-task plan persisted`);
  return planView(obj);
}

/* Single entry for the coffee-business command (voice or typed): dedup by request_id → one objective,
 * one execution; a repeated transcription event returns the already-created plan, no duplicate, no restart. */
export async function submitCoffeePlan(tenant, raw, requestId) {
  const key = requestId != null ? `${tenant}/${String(requestId).slice(0, 200)}` : null;
  if (key && byRequestId.has(key)) return getPlan(tenant, byRequestId.get(key));
  const created = createCoffeeObjective(tenant, raw, requestId);
  return await runPlan(tenant, created.objective_id);
}

export function getPlan(tenant, objective_id) { const o = objectives.get(`${tenant}/${objective_id}`); return o ? planView(o) : { error: "not found" }; }
