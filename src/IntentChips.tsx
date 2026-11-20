/* UI-01 (2026-11-20) — pure presentational module for the voice-first USER view:
 * the intent-chip expansion + the objective plan card. ZERO intent prose lives
 * here: chips receive their data at runtime from the engine
 * (GET /api/odai/intents via src/TalkView.tsx), and the plan card renders the
 * POST /api/odai/objectives response shape as-is. Exports are structured so
 * the shipped suite can render them with react-dom (tests/objectives.test.mjs,
 * UI-01 block). */

export type IntentItem = {
  id: string;
  label: string;
  utterance: string;
  engine: string;
  objective_template: string | null;
};

/* Defensive parse of the /intents response — anything the server did not
 * describe as {label, utterance} pairs simply does not render. */
export function parseIntentsResponse(j: unknown): IntentItem[] {
  const intents = (j as { intents?: unknown } | null)?.intents;
  if (!Array.isArray(intents)) return [];
  const out: IntentItem[] = [];
  for (const raw of intents) {
    const it = raw as Partial<IntentItem> | null;
    if (!it || typeof it.label !== "string" || typeof it.utterance !== "string") continue;
    out.push({
      id: typeof it.id === "string" ? it.id : it.label,
      label: it.label,
      utterance: it.utterance,
      engine: typeof it.engine === "string" ? it.engine : "objective",
      objective_template: typeof it.objective_template === "string" ? it.objective_template : null,
    });
  }
  return out;
}

/* The expansion of "What can you run for me?" — exactly ONE button per engine
 * intent: bold label + the utterance it stands for. Click = type + submit
 * (onPick is wired to the composer in TalkView). */
export function IntentChips({ items, onPick }: { items: IntentItem[]; onPick(it: IntentItem): void }) {
  return (
    <div className="intent-chips" role="group" aria-label="What AIVORA can run for you">
      {items.map((it) => (
        <button key={it.id} type="button" className="intent-chip" onClick={() => onPick(it)}>
          <strong>{it.label}</strong>
          <span>{it.utterance}</span>
        </button>
      ))}
    </div>
  );
}

/* ---- objective plan projection (POST /api/odai/objectives returns view(obj)) ---- */
export type ObjCriterion = {
  kind?: string; target_units?: number; via_catalog?: string | null;
  brand?: string | null; pct?: number; days?: number;
} | null;
export type ObjTask = { id: string; state: string; specialist?: string };
export type ObjGate = { id: string; scope: string; state: string };
export type ObjView = { objective_id: string; state: string; criterion: ObjCriterion; tasks: ObjTask[]; gates: ObjGate[] };

export const TASK_NAMES: Record<string, string> = {
  intake: "Understand the goal",
  plan: "Draft the plan",
  research_demand: "Research the demand",
  catalog_prepare: "Prepare catalog products",
  storefront_draft: "Draft your storefront",
  marketing_plan: "Marketing plan (draft)",
  schedule: "Set the run schedule",
  watch_verify: "Safety watch checks",
  channel_package: "Package the channels",
  fulfillment_sim: "Simulated fulfilment (TEST)",
  final_report: "Final report",
};

export function criterionLine(c: ObjCriterion): string {
  if (!c || typeof c !== "object") return "Measurable objective";
  if (c.kind === "units_sold") {
    const brand = typeof c.brand === "string" ? c.brand.replace(/ \(synthetic demo brand\)$/, "") : "";
    const via = c.via_catalog ? ` via ${c.via_catalog}` : "";
    return `Sell ${c.target_units ?? "?"} ${brand ? `${brand} ` : ""}products${via}`;
  }
  if (c.kind === "growth") return `Grow sales ${c.pct ?? "?"}% in ${c.days ?? "?"} days`;
  return "Measurable objective";
}

/* The single interpretation point for POST /objectives responses: on success
 * we render the plan card; on any engine error the returned reason — e.g.
 * "not measurable — restate with a number (units / % over days)" — travels to
 * the UI VERBATIM, rewritten by nobody. */
export function objectiveCreateOutcome(body: unknown): { ok: true; obj: ObjView } | { ok: false; hint: string } {
  const b = body as { error?: unknown; objective_id?: unknown; tasks?: unknown } | null;
  if (b && typeof b.error === "string") return { ok: false, hint: b.error };
  if (b && typeof b.objective_id === "string" && Array.isArray(b.tasks)) return { ok: true, obj: b as unknown as ObjView };
  return { ok: false, hint: "the engine returned no plan — try again, or say it to the mic" };
}

/* criterion + task plan + gates, awaiting-owner state front and center.
 * Light surface, black text, one green accent — no gradients, no dark blocks. */
export function ObjectivePlanCard({ label, o }: { label?: string; o: ObjView }) {
  const awaiting = o.state === "AWAITING_SPEND_APPROVAL" || o.gates.some((g) => g.state === "awaiting_owner");
  return (
    <div className="objcard">
      <h5>🎯 {label ? `${label} — plan ready` : "Plan ready"}</h5>
      <p className="objcrit">{criterionLine(o.criterion)}</p>
      {awaiting ? <div className="objstate">⏸ Awaiting owner approval — nothing runs until you approve the gates in MGMT</div> : null}
      <ol className="objtasks">
        {o.tasks.map((t) => (
          <li key={t.id} className={t.state === "done" ? "done" : undefined}>
            <span>{TASK_NAMES[t.id] ?? t.id}</span>
            <em>{t.state === "done" ? "done ✓" : t.state === "pending" ? "queued" : t.state}</em>
          </li>
        ))}
      </ol>
      <div className="objgates">
        {o.gates.map((g) => (
          <span
            key={g.id}
            className={`objgate${g.state === "awaiting_owner" ? " awaiting_owner"
              : g.state.startsWith("approved") || g.state.startsWith("released") ? " ok" : ""}`}
          >
            {g.scope} — {g.state === "awaiting_owner" ? "awaiting your approval" : g.state === "not_reached" ? "queued" : g.state.replace(/_/g, " ")}
          </span>
        ))}
      </div>
      <p className="objfine">runs under policy R01–R19 · figures are TEST until live data · publishing, spending and messaging wait for you</p>
    </div>
  );
}
