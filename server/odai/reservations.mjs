/* odai/reservations.mjs — WO-SEC05 atomic budget reservation primitives (SEC-05 REMEDIATION;
 * policy sheet 08 "Budget control"; closes tests/policy_gaps.txt REQUIRED FOLLOW-UP).
 *
 * MODEL: a budget scope is (tenant_id, scope_id) with a declared MYR cap. Reservation rows
 * form an explicit state machine:  held -> consumed | released  (consumed/released terminal).
 * Primitives: registerBudgetScope / reserve(=holdBudget) / consumeHold(=commitReservation) /
 * consumeOrReserve / releaseHolds / expireHolds / reconcileBudget.
 *
 * ATOMICITY (the accepted posture named in the gap file — "single-thread critical section or
 * durable SELECT ... FOR UPDATE equivalent"): EVERY primitive is a SYNCHRONOUS function and
 * the engine serves HTTP on one Node event-loop thread. Compare and mutate therefore happen
 * inside one uninterruptible critical section — there is NO await between reading
 * held+consumed and writing the new reservation state, so no JS read-modify-write window
 * exists across calls and concurrent reserve/approve requests are strictly serialized.
 * Two concurrent asks that would together breach a cap can never both pass the CAS.
 * INVARIANT (asserted by reconcileBudget): held + consumed <= cap at every instant, for
 * every scope, under any interleaving.
 *
 * DURABILITY: the authoritative store is the per-process odai memory plane (FC-ephemeral —
 * same documented posture as store.mjs/ledger.mjs; the objective row itself is equally
 * instance-scoped, so holds and their objective die together). The durable projection is a
 * `odai_budget_reservation` table via the existing odai db module — it needs a migration
 * (app never runs DDL; migrations belong outside this lease) and lands with the durable
 * attach slot. Nothing here fakes persistence.
 */

const DEFAULT_HOLD_TTL_MINUTES = 120;

/* scope store: Map key -> { tenant_id, scope_id, cap_myr, seq, created_at, rows: [row] }
 * row: { reservation_id, amount_myr, consumed_myr, state: held|consumed|released,
 *        issued_at, expires_at|null, meta }
 * Per-row accounting supports partial consumption without splitting rows:
 *   row held balance = amount_myr - consumed_myr while state === "held".
 */
const scopes = new Map();
const keyOf = (tenantId, scopeId) => String(tenantId) + "\u0000" + String(scopeId);

const isPos = (n) => { const x = Number(n); return Number.isFinite(x) && x > 0; };

function sweepExpiry(sc, nowMs) { // releases expired holds; synchronous, idempotent
  let released = 0;
  for (const r of sc.rows) {
    if (r.state === "held" && r.expires_at !== null && Date.parse(r.expires_at) <= nowMs) {
      r.state = "released"; released++; r.release_reason = "expired";
    }
  }
  return released;
}

function totals(sc) { // after sweepExpiry
  let held = 0; let consumed = 0; let released = 0; let open = 0;
  for (const r of sc.rows) {
    consumed += r.consumed_myr;
    if (r.state === "held") { held += r.amount_myr - r.consumed_myr; open++; }
    else if (r.state === "released") released += r.amount_myr - r.consumed_myr;
  }
  return { held, consumed, released, open };
}

function snap(sc, extra = {}) {
  const { held, consumed, released } = totals(sc);
  return {
    scope_id: sc.scope_id, tenant_id: sc.tenant_id, cap_myr: sc.cap_myr,
    held_myr: held, consumed_myr: consumed, released_myr: released,
    available_myr: Math.round((sc.cap_myr - held - consumed) * 100) / 100,
    /* WO-SEC05 core invariant — held+consumed NEVER exceeds the declared cap: */
    within_cap: held + consumed <= sc.cap_myr + 1e-9,
    ...extra,
  };
}

/** register / re-confirm a declared cap for a scope. Re-register with the SAME cap is
 *  idempotent; a different cap on a scope that already has reservations is refused
 *  (a declared budget is never silently widened or narrowed under existing holds). */
export function registerBudgetScope(tenantId, scopeId, capMyr, meta = {}) {
  if (!tenantId || !scopeId) return { ok: false, reason: "NO_SCOPE", detail: "tenant_id and scope_id required" };
  const cap = Number(capMyr);
  if (!isPos(cap)) return { ok: false, reason: "INVALID_CAP", detail: "cap_myr must be a positive number" };
  const k = keyOf(tenantId, scopeId);
  const sc = scopes.get(k);
  if (sc) {
    if (sc.cap_myr === cap) return { ok: true, existing: true, budget: snap(sc) };
    return { ok: false, reason: "CAP_LOCKED", detail: `scope already declared with cap RM${sc.cap_myr}; refusing RM${cap} under outstanding holds` };
  }
  const fresh = { tenant_id: String(tenantId), scope_id: String(scopeId), cap_myr: cap, seq: 0, created_at: new Date().toISOString(), rows: [], meta };
  scopes.set(k, fresh);
  return { ok: true, existing: false, budget: snap(fresh) };
}

/** get a registered scope snapshot (or null) — read-only. */
export function budgetScope(tenantId, scopeId) {
  const sc = scopes.get(keyOf(tenantId, scopeId));
  if (!sc) return null;
  sweepExpiry(sc, Date.now());
  return snap(sc);
}

/* ---- core CAS: the ONLY place cap arithmetic mutates state; never async ---- */
function casReserve(sc, amount, { ttlMinutes = DEFAULT_HOLD_TTL_MINUTES, source = null, note = null, consumeImmediately = false } = {}) {
  sweepExpiry(sc, Date.now());
  const { held, consumed } = totals(sc);
  const available = sc.cap_myr - held - consumed;
  if (amount > available + 1e-9) {
    return { ok: false, reason: "OVER_REMAINING_CAP", budget: snap(sc), detail: `ask RM${amount} vs remaining RM${Math.max(0, available)} (cap RM${sc.cap_myr}, held RM${held}, consumed RM${consumed})` };
  }
  sc.seq += 1;
  const now = new Date();
  const row = {
    reservation_id: `RES-${sc.tenant_id}-${sc.scope_id}-${sc.seq}`,
    amount_myr: amount, consumed_myr: consumeImmediately ? amount : 0,
    state: consumeImmediately ? "consumed" : "held",
    issued_at: now.toISOString(),
    expires_at: consumeImmediately ? null : new Date(now.getTime() + ttlMinutes * 60000).toISOString(),
    meta: { source, note },
  };
  sc.rows.push(row);
  return { ok: true, reservation: row, budget: snap(sc) };
}

/** reserve(scope_id, amount): atomic compare-and-set against the remaining cap.
 *  Creates a HELD reservation. Unknown scope fails CLOSED — nothing is held against
 *  a cap the engine never registered. */
export function reserve(tenantId, scopeId, amount, opts = {}) {
  const sc = scopes.get(keyOf(tenantId, scopeId));
  if (!sc) return { ok: false, reason: "NO_BUDGET_SCOPE", detail: `no registered cap for scope ${String(scopeId)} — fail closed (SEC-05)` };
  if (!isPos(amount)) return { ok: false, reason: "INVALID_AMOUNT", detail: "amount must be a positive number" };
  return casReserve(sc, Number(amount), { ...opts, consumeImmediately: false });
}
export const holdBudget = reserve;

/** consumeHold / commitReservation: approve() consumes HELD reservations ONLY.
 *  Partial consumption is supported (a held row keeps its unspent balance held);
 *  a fully consumed row flips held -> consumed. Refused when unexpired holds cannot
 *  cover the ask, never dipped into unheld cap. */
export function consumeHold(tenantId, scopeId, amount, opts = {}) {
  const sc = scopes.get(keyOf(tenantId, scopeId));
  if (!sc) return { ok: false, reason: "NO_BUDGET_SCOPE", detail: `no registered cap for scope ${String(scopeId)} — fail closed (SEC-05)` };
  if (!isPos(amount)) return { ok: false, reason: "INVALID_AMOUNT", detail: "amount must be a positive number" };
  sweepExpiry(sc, Date.now());
  const ask = Number(amount);
  const { held } = totals(sc);
  if (held + 1e-9 < ask) {
    return { ok: false, reason: "NO_HELD_RESERVATION", budget: snap(sc), detail: `held RM${held} < ask RM${ask}; approval must consume a held reservation, never unheld cap` };
  }
  let left = ask; const touched = [];
  for (const r of sc.rows) {
    if (left <= 1e-9) break;
    if (r.state !== "held") continue;
    const bal = r.amount_myr - r.consumed_myr;
    if (bal <= 1e-9) continue;
    const take = Math.min(bal, left);
    r.consumed_myr = Math.round((r.consumed_myr + take) * 100) / 100;
    left -= take; touched.push(r.reservation_id);
    if (r.amount_myr - r.consumed_myr <= 1e-9) r.state = "consumed";
  }
  return { ok: true, consumed_myr: ask, reservations: touched, budget: snap(sc), source: opts.source || null };
}
export const commitReservation = consumeHold;

/** Atomic reserve-and-consume in one critical section — used by the money ledger for
 *  registered scopes: prefer consuming outstanding HELD reservations (approval holds),
 *  fall back to direct consumption of remaining cap, refuse anything over the cap.
 *  A single step; no window between decide and record. */
export function consumeOrReserve(tenantId, scopeId, amount, opts = {}) {
  const sc = scopes.get(keyOf(tenantId, scopeId));
  if (!sc) return { ok: true, registered: false, detail: "no budget scope — cap-agnostic money fact (legacy posture, unchanged)" };
  if (!isPos(amount)) return { ok: false, reason: "INVALID_AMOUNT", detail: "amount must be a positive number" };
  sweepExpiry(sc, Date.now());
  const { held } = totals(sc);
  if (held + 1e-9 >= amount) return consumeHold(tenantId, scopeId, amount, opts);
  return casReserve(sc, Number(amount), { consumeImmediately: true, source: opts.source || null, note: opts.note || null });
}

/** release unspent holds (owner decline, explicit rollback, expiry sweep).
 *  Consumed portions are irretractable — the money fact, if appended, stands. */
export function releaseHolds(tenantId, scopeId, reason = "released", { reservation_id = null } = {}) {
  const sc = scopes.get(keyOf(tenantId, scopeId));
  if (!sc) return { ok: false, reason: "NO_BUDGET_SCOPE" };
  sweepExpiry(sc, Date.now());
  let released = 0;
  for (const r of sc.rows) {
    if (r.state !== "held") continue;
    if (reservation_id && r.reservation_id !== reservation_id) continue;
    r.state = "released"; r.release_reason = String(reason); released += 1;
  }
  return { ok: true, released, budget: snap(sc) };
}

/** explicit expiry pass (also runs implicitly at the head of every primitive) */
export function expireHolds(tenantId = null, scopeId = null) {
  const now = Date.now();
  let swept = 0;
  for (const [k, sc] of scopes) {
    if (tenantId && sc.tenant_id !== String(tenantId)) continue;
    if (scopeId && sc.scope_id !== String(scopeId)) continue;
    swept += sweepExpiry(sc, now);
  }
  return { ok: true, expired_holds: swept };
}

/** reconciliation — "reports held-vs-consumed-vs-cap invariants". scope omitted = all
 *  scopes for the tenant (or every scope when tenant omitted too). Violations are
 *  machine-checkable, fail-closed by construction. */
export function reconcileBudget(tenantId = null, scopeId = null) {
  const rows = [];
  const now = Date.now();
  for (const [k, sc] of scopes) {
    if (tenantId && sc.tenant_id !== String(tenantId)) continue;
    if (scopeId && sc.scope_id !== String(scopeId)) continue;
    sweepExpiry(sc, now);
    const s = snap(sc);
    const badStates = sc.rows.filter((r) => !["held", "consumed", "released"].includes(r.state));
    const badLedger = sc.rows.filter((r) => r.consumed_myr < 0 || r.consumed_myr > r.amount_myr);
    const violations = [];
    if (!s.within_cap) violations.push("HELD_PLUS_CONSUMED_EXCEEDS_CAP");
    if (badStates.length) violations.push("ROW_STATE_MACHINE_BROKEN");
    if (badLedger.length) violations.push("ROW_CONSUMED_OUT_OF_BOUNDS");
    rows.push({ ...s, reservation_rows: sc.rows.length, held_open: totals(sc).open, violations });
  }
  return rows.length === 1 ? rows[0] : { scopes: rows, scope_count: rows.length, violations: rows.flatMap((r) => r.violations.map((v) => r.scope_id + ":" + v)) };
}
