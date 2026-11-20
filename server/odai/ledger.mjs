/* odai/ledger.mjs — WO-104 additive money-event ledger (batch A1).
 * Immutable, append-only, tenant-scoped. Backs the money skills (SK-004/008/024/030
 * per DEV-01 §3; first consumer: skills.mjs#skill_ledger_append).
 *
 * NO PII COLUMNS BY DESIGN (PR-02 field minimization): the event schema is a closed
 * whitelist — event_id, tenant_id, objective_id, task_id, amount_myr (positive number),
 * direction ("in" | "out"), category, source_tag (provenance, PR-06), at (server clock),
 * seq. Customer names, contact details, raw inputs, prompts and model outputs NEVER
 * enter this store; those live (if at all) behind their own tables with owner-approved
 * retention. Events are irretractable: there is deliberately NO update/delete/correct
 * API — corrections are new counter-events referencing event_id_replaces.
 *
 * RLS NOTES for the durable Supabase attach (migration slot; mirror of odai/migrations
 * idempotent-DDL convention — app never runs DDL):
 *   create table odai_money_event (
 *     event_id text primary key, tenant_id text not null, objective_id text, task_id text,
 *     amount_myr numeric not null check (amount_myr >= 0),
 *     direction text not null check (direction in ('in','out')),
 *     category text, source_tag text not null, seq bigint, at timestamptz default now());
 *   alter table odai_money_event enable row level security;
 *   create policy tenant_select on odai_money_event for select using (tenant_id = current_setting('app.tenant_id')::text);
 *   create policy append_only_insert on odai_money_event for insert with check (tenant_id = current_setting('app.tenant_id')::text);
 *   -- no update/delete policies exist => RLS denies them (fail closed, SEC-06 evidence anchor)
 *
 * In this staging build the ledger is in-memory per process (FC-ephemeral, same posture
 * as store.mjs); the durable projection is the documented next slot. logEvent mirrors
 * the append as an audit trace (odai_trace) without duplicating amounts.
 */
import { get, logEvent } from "./store.mjs";

const EVENTS = new Map(); // tenantId -> array of frozen events (append-only)
const ALLOWED_FIELDS = ["event_id", "tenant_id", "objective_id", "task_id", "amount_myr", "direction", "category", "source_tag", "at", "seq"];

export function appendMoneyEvent(tenantId, ev) {
  if (!tenantId) return { error: "tenant_id required (tenant-scoped, no cross-tenant writes)" };
  const amount = Number(ev.amount_myr);
  if (!Number.isFinite(amount) || amount < 0) return { error: "amount_myr must be a non-negative number (MYR; no invented figures)" };
  if (!["in", "out"].includes(ev.direction)) return { error: "direction must be in|out" };
  if (!String(ev.source_tag || "").trim()) return { error: "source_tag required — provenance (PR-06/SEC-06); no untagged money" };
  const list = EVENTS.get(tenantId) || [];
  const seq = (list[list.length - 1]?.seq || 0) + 1; // deterministic per-tenant order
  const frozen = Object.freeze({
    event_id: `ME-${tenantId}-${seq}`, tenant_id: String(tenantId),
    objective_id: ev.objective_id ? String(ev.objective_id) : null,
    task_id: ev.task_id ? String(ev.task_id) : null,
    amount_myr: amount, direction: ev.direction,
    category: ev.category ? String(ev.category) : "uncategorized",
    source_tag: String(ev.source_tag), seq,
    at: new Date().toISOString(),
    ...(ev.event_id_replaces ? { event_id_replaces: String(ev.event_id_replaces) } : {}),
  });
  // whitelist enforcement — the shape cannot carry anything else
  for (const k of Object.keys(frozen)) if (!ALLOWED_FIELDS.includes(k) && k !== "event_id_replaces") return { error: "field not permitted in money ledger: " + k };
  EVENTS.set(tenantId, [...list, frozen]); // copy-on-append: prior array instance never mutates
  try { logEvent(get(tenantId), { runId: ev.task_id ? String(ev.task_id) : "·", beat: "·", actor: "finance_ledger_agent", kind: "MONEY_EVENT_APPEND", decision: "ALLOW", note: `${frozen.direction} seq=${seq} src=${frozen.source_tag}` }); } catch { /* audit mirror is best-effort; the ledger append stands */ }
  return { event: frozen };
}

export function moneyEvents(tenantId, { objective_id = null } = {}) {
  const list = EVENTS.get(tenantId) || [];
  return objective_id ? list.filter((e) => e.objective_id === objective_id) : [...list];
}

export function moneyTotals(tenantId, { objective_id = null } = {}) {
  let money_in = 0; let money_out = 0; let count = 0;
  for (const e of moneyEvents(tenantId, { objective_id })) { count++; if (e.direction === "in") money_in += e.amount_myr; else money_out += e.amount_myr; }
  return { money_in, money_out, net: money_in - money_out, count };
}
