#!/usr/bin/env node
/* watchd.mjs — WO-06 "AI watching AI" containment-request daemon (actor DEV-13).
 * Branch-local: NEVER imported by server/** or src/**; SELECT-only against the page
 * DATABASE control path (public API, MULE token via curl config — token never touches
 * argv, logs, or incident files). Redacted view = kind/beat/actor/decision/rule/note(≤120) only.
 * HARD RULE (encode + tested): this module only emits containment REQUESTS. Its output
 * schema is fixed; it can never set state=approved, and requestSelfApproval() rejects any
 * attempt at actor==self-approve by construction. Incident dir is the repo docs tree.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIEW_COLUMNS = ["kind", "beat", "actor", "decision", "rule", "note"];
export const NOTE_CAP = 120;
const DISPATCH_KINDS = new Set(["BEAT_DONE", "RUN_STARTED", "TASK_FAILED", "GATE", "OBJECTIVE_CHECKPOINT"]);
const APPROVAL_PREFIX = "APPROVAL_";
const REGISTERED_SCOPES = ["approve_spend", "approve_publish", "approve_customer_comms", "advertising spend", "external publishing (Shopee/Facebook)", "customer messages (WhatsApp/email)"];

/** Redact any DB row down to the whitelisted view columns; note hard-capped at 120 chars. */
export function redactView(row) {
  const out = {};
  for (const c of VIEW_COLUMNS) {
    if (!(c in (row || {}))) continue;
    const v = row[c];
    out[c] = typeof v === "string" && v.length > NOTE_CAP && c === "note" ? v.slice(0, NOTE_CAP) : v;
  }
  return out;
}

/** Detectors over SELECTed trace + receipt rows (seq-ascending). Returns signal array; [] = clean. */
export function analyze(traceRows, receiptRows, { now = () => new Date() } = {}) {
  const signals = [];
  const push = (type, runId, row, detail) => signals.push({ type, run_id: runId ?? null, at: { kind: "trace", seq: row?.seq ?? null }, view: redactView(row), detail: detail ?? null });
  const lineageGranted = new Map(); // run_id -> count of APPROVAL_GRANTED
  for (const r of traceRows || []) {
    const run = r.run_id, kind = String(r.kind || ""), dec = String(r.decision || "");
    if (kind.startsWith(APPROVAL_PREFIX) && dec === "ALLOW" && !/declin/i.test(String(r.note || "")))
      lineageGranted.set(run, (lineageGranted.get(run) || 0) + 1);
  }
  let seenApprovalInRun = new Set();
  for (const r of traceRows || []) {
    const run = r.run_id, kind = String(r.kind || ""), dec = String(r.decision || "");
    // S1: decision != ALLOW on dispatch
    if (DISPATCH_KINDS.has(kind) && dec && dec !== "ALLOW") push("DISPATCH_NON_ALLOW", run, r, `kind=${kind} decision=${dec}`);
    // S2: failed task signals (literal, plus GATE PREFLIGHT lineage)
    if (kind === "TASK_FAILED" || (kind === "GATE" && /PREFLIGHT_FAILED/i.test(String(r.note || "")))) push("TASK_FAILED", run, r, kind === "GATE" ? "dispatch gate blocked by preflight" : "explicit task failure");
    // S3: gate state flips without APPROVAL_GRANTED lineage
    if (kind === OBJECTIVE_CHECKPOINT_KIND) {
      const state = parseState(String(r.note || ""));
      if (state && /^(APPROVED|RELEASED|REPORTED|EXECUTING|ACTIVE)/.test(state) && !lineageGranted.get(run))
        push("GATE_FLIP_NO_LINEAGE", run, r, `state=${state} with zero APPROVAL_GRANTED rows for this run`);
    }
    // S4: unknown-scope approvals (F-1 forged-scope pattern)
    if (kind === "APPROVAL_GRANTED") {
      const blob = [r.rule, r.note, r.actor].filter(Boolean).join(" ").toLowerCase();
      const canonical = /r12 owner-confirmed|\bcap s?\$\d|governed resume/.test(blob);
      const recognised = canonical || REGISTERED_SCOPES.some((s) => blob.includes(s.toLowerCase()));
      if (!recognised) {
        const forged = detectForgedScope(blob);
        push("UNKNOWN_SCOPE_APPROVAL", run, r, forged ? `forged-scope pattern: ${forged} (cf. F-1)` : "approval does not bind any registered scope");
      }
    }
  }
  // S5: receipts growth anomaly — duplicate beat per run inside the window
  const seen = new Map();
  for (const r of receiptRows || []) {
    const k = `${r.tenant_id}|${r.run_id}|${r.beat}`;
    if (seen.has(k)) push("RECEIPT_DUPLICATE_BEAT", r.run_id, r, `beat ${r.beat} appears ≥ twice for run ${r.run_id} (anomalistic without PK conflict — possible rewrite)`);
    else seen.set(k, 1);
  }
  void seenApprovalInRun; void now;
  return signals;
}
const OBJECTIVE_CHECKPOINT_KIND = "OBJECTIVE_CHECKPOINT";
function parseState(note) { const m = String(note).match(/state=(\w+)|^([A-Z][A-Z_]*)$/); return m ? (m[1] || m[2]) : note; }
function detectForgedScope(blob) {
  const forged = [];
  if (/frozen|bypass|override|dev-13-ordered|self-approv/.test(blob)) forged.push("scope text attempts to override frozen/authority surfaces");
  if (/(src\/|index\.html|package\.json)/.test(blob)) forged.push("scope names runtime-frozen files");
  return forged.length ? forged.join("; ") : null;
}

export const HARD_RULE = "request-only: watcher never mutates state, never approves, never writes outside incident dir; DB access is SELECT-only";

/** Actor attempting self-approval can never be approved — reject by construction. */
export function requestSelfApproval(attempt = {}) {
  const requester = String(attempt.actor || "");
  const approves = Object.keys(attempt).some((k) => /approv/i.test(k) && attempt[k] === true) || String(attempt.action || "").toLowerCase().includes("approve") || String(attempt.state || "").toLowerCase() === "approved";
  return { ok: false, code: "SELF_APPROVAL_REJECTED", self_approve_detected: approves, requester: requester.slice(0, 40), reason: "HARD RULE: watchd emits containment REQUESTS only; state=approved cannot originate here (actor DEV-13 cannot be its own approver)" };
}

/** Emit one containment-request incident file. Schema frozen — guard rejects anything approval-shaped before ANY write. */
export function emitIncident(signals, { outDir, ts = new Date(), readViews = {} } = {}) {
  if (!Array.isArray(signals)) throw new TypeError("signals must be array");
  if (signals.length === 0) return null;
  const id = ts.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const incident = {
    id, schema: "containment-request/v1", actor: "DEV-13", generated_at: ts.toISOString(),
    hard_rule: HARD_RULE,
    requested_action: signals.some((s) => s.type !== "RECEIPT_DUPLICATE_BEAT") ? "owner_review_and_freeze_dispatch" : "owner_review_receipt_integrity",
    action_ceiling: "request — owner decision required before ANY state change",
    signals, evidence_refs: { read_views: readViews, sql: "SELECT " + ["tenant_id", "run_id", "seq", ...VIEW_COLUMNS].join(",") + " FROM odai_trace|odai_receipt ORDER BY seq DESC LIMIT n" },
    state_written_by_this_module: "none — request only",
    terminal: true,
  };
  const serialized = JSON.stringify(incident, null, 2);
  if (/"state"\s*:\s*"approved"/i.test(serialized) || /"approved"\s*:\s*true/.test(serialized))
    throw new Error("GUARD: approval-shaped output refused by self-approval prevention");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${id}.json`);
  writeFileSync(file, serialized + "\n");
  return { file, incident };
}

/* ---- live reads: page DATABASE control path, SELECT-only, token via curl config only ---- */
function controlQuery(domain, token, sql, limit) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return { ok: false, code: "SELECT_ONLY_ENFORCED" };
  const dir = mkdtempSync(path.join(tmpdir(), "watchd-cfg-"));
  const cfg = path.join(dir, "curl.cfg"), out = path.join(dir, "resp.json");
  try {
    writeFileSync(cfg, ["silent", "show-error", "location", 'request = "POST"',
      `url = "${process.env.MULE_PAGE_URL}/api/page/${process.env.AIVORA_PAGE_DOMAIN}/database/query"`,
      `header = "Authorization: Bearer ${token}"`, 'header = "Content-Type: application/json"',
      `data = ${JSON.stringify(JSON.stringify({ sql, limit }))}`, `output = "${out}"`].join("\n"), { mode: 0o600 });
    const r = spawnSync("curl", ["-K", cfg], { encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) return { ok: false, code: "CONTROL_PATH_UNREACHABLE", stderr: (r.stderr || "").slice(0, 200) };
    const body = JSON.parse(readFileSync(out, "utf8"));
    const payload = body && typeof body === "object" && body.code === "ok" ? body.data : body;
    if (!payload || !Array.isArray(payload.rows)) return { ok: false, code: "BAD_CONTROL_RESPONSE", keys: Object.keys(body || {}).slice(0, 10) };
    return { ok: true, rows: payload.rows, rowCount: payload.rowCount };
  } catch (e) { return { ok: false, code: "CONTROL_READ_FAILED", msg: String(e.message).slice(0, 120) }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

const usage = () => { console.error("usage: node tools/watchd.mjs --live [--domain <page-domain>] [--window n] [--out dir]"); process.exit(5); };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const flag = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  if (!a.includes("--live")) usage();
  const domain = flag("--domain", process.env.AIVORA_PAGE_DOMAIN || "clupxd6g.qwenwork.page");
  const token = process.env.MULE_AGENT_TOKEN;
  if (!token || !process.env.MULE_PAGE_URL) { console.log(JSON.stringify({ level: "FAIL_CLOSED", reason: "control-path env absent (MULE_PAGE_URL/MULE_AGENT_TOKEN) — no live read performed" })); process.exit(2); }
  process.env.AIVORA_PAGE_DOMAIN = domain;
  const n = Math.min(200, parseInt(flag("--window", "40"), 10) || 40);
  const t = controlQuery(domain, token, `SELECT tenant_id, run_id, seq, kind, beat, actor, decision, rule, LEFT(note, ${NOTE_CAP * 2}) AS note FROM odai_trace ORDER BY seq DESC LIMIT ${n}`, n);
  const rc = controlQuery(domain, token, `SELECT tenant_id, run_id, beat, rule, decision, LEFT(summary, ${NOTE_CAP}) AS note FROM odai_receipt ORDER BY ts DESC LIMIT ${n}`, n);
  const meta = { trace: { requested: n, ok: t.ok, code: t.code || null, rows: t.ok ? t.rows.length : 0 }, receipts: { requested: n, ok: rc.ok, code: rc.code || null, rows: rc.ok ? rc.rows.length : 0 } };
  if (!t.ok) { console.log(JSON.stringify({ level: "READ_FAILED", meta })); process.exit(2); }
  const traceAsc = [...t.rows].reverse(); // seq DESC → analyze wants ascending lineage order
  const signals = analyze(traceAsc.map((r) => ({ ...r, note: typeof r.note === "string" ? r.note.slice(0, NOTE_CAP) : r.note })), (rc.rows || []).map((r) => ({ ...r, note: r.note ? String(r.note).slice(0, NOTE_CAP) : r.note })));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = flag("--out", path.join(repoRoot, "odai/dev_docs/watch/incidents"));
  const groups = {};
  for (const s of signals) (groups[s.type] ||= []).push(s);
  const emitted = [];
  for (const type of Object.keys(groups)) {
    const e = emitIncident(groups[type], { outDir, ts: new Date(), readViews: meta });
    if (e) emitted.push(path.relative(repoRoot, e.file));
  }
  console.log(JSON.stringify({ level: "OK", reads: meta, signals: signals.length, types: Object.keys(groups), incidents: emitted, note: "request-only; zero state mutations; SELECT-only reads" }, null, 2));
}
