/* UI-01B (owner P3 amendment, 2026-11-21) — client-side demo ROLE GATE + the
 * admin surface that owns ALL intent chips and registry prose.
 *
 * The DEFAULT USER view never renders chips or registry prose: the voice-first
 * big mic stays the sole primary action and the typing composer is retained
 * (optional, understated) underneath. Intent chips remain reachable ONLY via
 * the Admin role surface.
 *
 * Deliberately minimal and client-side (per directive): sessionRole() reads
 * ?role=admin from the URL — the endpoint surfaces it uses (/api/odai/intents,
 * /api/odai/registry) are auth-less demo surfaces anyway — and persists ADMIN
 * in localStorage so the demo survives reloads. Default (everything else,
 * including any failure to read) fails CLOSED to USER. No server auth is
 * implied or bypassed; nothing here gates a protected capability — it only
 * gates which SURFACE is displayed.
 *
 * ZERO intent prose lives in this module too: chips arrive as props from the
 * engine registry, counts from GET /api/odai/registry, exactly as shipped in
 * UI-01/WO-A1 (the zero-prose bundle audit stays enforced by the test suite). */

import { IntentChips, type IntentItem } from "./IntentChips";

export type Role = "USER" | "ADMIN";

/* localStorage key that persists the demo role across reloads. */
export const ADMIN_ROLE_KEY = "aivora_demo_role";

/* Pure classifier — testable without a DOM: the ?role=admin query wins;
 * otherwise the persisted value must be exactly "ADMIN"; anything else
 * (junk, absent, unreadable) is USER. */
export function classifyRole(search: string, stored: string | null): Role {
  let flag: string | null = null;
  try {
    flag = new URLSearchParams(search).get("role");
  } catch {
    flag = null;
  }
  if (typeof flag === "string" && flag.toLowerCase() === "admin") return "ADMIN";
  return stored === "ADMIN" ? "ADMIN" : "USER";
}

/* Application-side read: ?role=admin persists ADMIN for the demo, later loads
 * restore it; there is no client-side way to escalate anything else. */
export function sessionRole(): Role {
  let search = "";
  let stored: string | null = null;
  try {
    search = window.location.search;
  } catch {
    /* no DOM (unit renders import the module, never call it) */
  }
  try {
    stored = window.localStorage.getItem(ADMIN_ROLE_KEY);
  } catch {
    /* storage disabled ⇒ USER */
  }
  const role = classifyRole(search, stored);
  if (role === "ADMIN" && stored !== "ADMIN") {
    try {
      window.localStorage.setItem(ADMIN_ROLE_KEY, "ADMIN");
    } catch {
      /* demo persist is best-effort */
    }
  }
  return role;
}

/* ---- Defensive parse of GET /api/odai/registry — counts + version only. ---- */
export type RegistrySummaryView = { version: string; counts: { name: string; value: number }[] };

export function parseRegistrySummary(j: unknown): RegistrySummaryView | null {
  const b = j as { registry_version?: unknown; counts?: unknown } | null;
  if (!b || typeof b !== "object" || !b.counts || typeof b.counts !== "object") return null;
  const counts: { name: string; value: number }[] = [];
  for (const [k, v] of Object.entries(b.counts as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) counts.push({ name: k.replace(/_/g, " "), value: v });
  }
  if (!counts.length) return null;
  const version = typeof b.registry_version === "string" ? b.registry_version : "";
  return { version, counts };
}

/* ---- The ONLY place chips + registry prose can render. Role USER ⇒ null,
 * so the shipped default tree provably carries zero chip labels (UI-01B).
 * Light discipline kept: white card, black text, one green accent. ---- */
export function AdminPanel({ role, intents, registry, err, onPick }: {
  role: Role;
  intents: IntentItem[] | null;
  registry: RegistrySummaryView | null;
  err?: string | null;
  onPick(it: IntentItem): void;
}) {
  if (role !== "ADMIN") return null;
  return (
    <aside className="admin-panel" data-admin-surface="true">
      <div className="admin-head">
        <b>AIVORA · Admin</b>
        <span className="admin-badge">demo role</span>
      </div>
      <h4>What can you run for me?</h4>
      {intents
        ? <IntentChips items={intents} onPick={onPick} />
        : <p className="chips-note">{err ? `Intent list unavailable — ${err} · reload to retry` : "Asking the engine…"}</p>}
      {registry ? (
        <div className="admin-registry">
          <h5>Registry summary <em>GET /api/odai/registry</em></h5>
          <ul>
            {registry.counts.map((c) => <li key={c.name}><span>{c.name}</span><b>{c.value}</b></li>)}
          </ul>
          {registry.version ? <p className="admin-version">registry v{registry.version}</p> : null}
        </div>
      ) : null}
    </aside>
  );
}
