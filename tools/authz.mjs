#!/usr/bin/env node
/* authz.mjs — WO-09A deterministic pre-exec authorization (DEV-08 ordered work order).
 * Branch-local enforcement tool: NEVER imported by src/** or server/**; node builtins only
 * (tests/authz.test.mjs asserts inertness, same rule as the WO-05 harness / WO-06 watchd).
 *
 *   issue  <WO-ID> --paths <csv> --minutes N [--ops check,commit] [--budget 12] [--single-use]
 *   touch  <WO-ID>                        — re-extends expiry by the lease's own minutes
 *   check  <WO-ID> --op <op> [--path <p>] — EVERY protected action must call this first
 *   revoke <WO-ID> <why>
 *   status
 *
 * Lease store : odai/dev_docs/leases.json
 *               {id:{issued_at,expires_at,minutes,paths,ops,budget,single_use,used_by_op,revoked}}
 * Audit log   : odai/dev_docs/authz-ledger.txt — append-only; the single live evidence log now.
 *               Every issue / check-denied / revoke appends exactly one line.
 * Halt sentinel: odai/dev_docs/HALT — same file-existence guard pattern as the ui_dispatch.txt
 *               dispatch sentinel: presence alone stops every grant (reason HALTED).
 *
 * Denials exit 2 with a machine reason:
 *   EXPIRED | REVOKED | OVER_BUDGET | PATH_NOT_ALLOWED | OP_NOT_ALLOWED | CONSUMED_RESUME |
 *   HALTED | NO_LEASE | INTEGRITY_FAILED
 * (INTEGRITY_FAILED = the WO-09A watchdog refused to certify the enforcement files; a check
 *  always calls tools/verify_integrity.mjs before anything is granted or consumed.)
 *
 * publish: grantable ONLY while an owner token is present in the environment
 * (ODAI_OWNER_TOKEN — presence is checked, the value is never read, printed, hashed or stored).
 * No owner token ⇒ publish cannot be issued and can never pass check ⇒ OP_NOT_ALLOWED.
 *
 * Exit codes: 0 granted / command ok | 2 denied (fail-closed) | 5 usage error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEASES_FILE = "odai/dev_docs/leases.json";
export const LEDGER_FILE = "odai/dev_docs/authz-ledger.txt";
export const HALT_SENTINEL = "odai/dev_docs/HALT";
export const INTEGRITY_TOOL = "tools/verify_integrity.mjs";
export const DEFAULT_BUDGET = 12;
export const OWNER_TOKEN_ENV = "ODAI_OWNER_TOKEN";
export const DENIAL_REASONS = ["EXPIRED", "REVOKED", "OVER_BUDGET", "PATH_NOT_ALLOWED", "OP_NOT_ALLOWED", "CONSUMED_RESUME", "HALTED", "NO_LEASE", "INTEGRITY_FAILED"];
export const EXIT = { GRANTED: 0, DENIED: 2, USAGE: 5 };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OP_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const normalizePath = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");

/** True when `p` sits inside the lease's scope. "*" = whole tree; entries ending in / are prefixes. */
export function pathAllowed(lease, p) {
  const q = normalizePath(p);
  if (!q || q.startsWith("/") || q.split("/").includes("..")) return false;
  const paths = (lease && lease.paths) || [];
  if (paths.includes("*")) return true;
  return paths.some((e) => (e.endsWith("/") ? q.startsWith(e) : q === e));
}

function opList(lease) { return (lease && lease.ops) || []; }
function usedTotal(lease) {
  const m = (lease && lease.used_by_op) || {};
  return Object.values(m).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** Pure decision — no clock, no fs, no store mutation. `now` is an epoch-ms number. */
export function evaluate(lease, { op, p, now, ownerToken }) {
  const deny = (reason, detail) => ({ granted: false, reason, detail });
  if (!lease) return deny("NO_LEASE", "no lease for this WO id in " + LEASES_FILE);
  if (lease.revoked) return deny("REVOKED", String(lease.revoked_reason || "lease revoked"));
  if (Date.parse(lease.expires_at) <= now) return deny("EXPIRED", "expires_at=" + lease.expires_at);
  if (!OP_RE.test(String(op))) return deny("OP_NOT_ALLOWED", "malformed op");
  if (op === "publish" && !ownerToken) return deny("OP_NOT_ALLOWED", "publish requires an owner token; none present");
  if (!opList(lease).includes(op)) return deny("OP_NOT_ALLOWED", "lease ops=" + opList(lease).join(","));
  if (p !== undefined && p !== "" && !pathAllowed(lease, p)) return deny("PATH_NOT_ALLOWED", "path=" + normalizePath(p) + " scope=" + lease.paths.join(","));
  const used = usedTotal(lease);
  if (lease.single_use && used >= 1) return deny("CONSUMED_RESUME", "single-use lease already consumed (used=" + used + ")");
  if (used >= (lease.budget || DEFAULT_BUDGET)) return deny("OVER_BUDGET", "used=" + used + "/" + (lease.budget || DEFAULT_BUDGET));
  return { granted: true, reason: "GRANT", detail: "op=" + op + (p ? " path=" + normalizePath(p) : "") + " used=" + (used + 1) + "/" + (lease.budget || DEFAULT_BUDGET) };
}

/* ---- store + ledger ---- */
function readLeases(root) {
  const f = path.join(root, LEASES_FILE);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")) || {}; } catch { return null; } /* corrupt ⇒ fail closed */
}
function writeLeases(root, leases) {
  const f = path.join(root, LEASES_FILE);
  mkdirSync(path.dirname(f), { recursive: true });
  const keys = Object.keys(leases).sort();
  const out = {}; for (const k of keys) out[k] = leases[k];
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, f);
}
const sanitize = (s) => (s === undefined || s === null ? "" : String(s)).replace(/([|\n\r])/g, ";").slice(0, 200);

/** One append-only line: <iso>|<EVENT>|<WO-ID>|k=v|k=v */
export function ledgerLine(event, id, fields = {}) {
  const parts = [new Date().toISOString().replace(/\.\d+Z$/, "Z"), event, id];
  for (const [k, v] of Object.entries(fields)) parts.push(k + "=" + sanitize(v));
  return parts.join("|") + "\n";
}
function ledgerAppend(root, line) {
  const f = path.join(root, LEDGER_FILE);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, line, { flag: "a" });
  return f;
}

/* ---- watchdog gate: called before any grant/consume ---- */
function integrityGate(root, toolPath = INTEGRITY_TOOL) {
  const tool = path.join(root, toolPath);
  if (!existsSync(tool)) return { ok: false, why: "watchdog tool absent — enforcement infrastructure missing" };
  const r = spawnSync(process.execPath, [tool, "check", "--root", root], { encoding: "utf8" });
  if (r.error) return { ok: false, why: "watchdog unrunnable: " + r.error.message };
  if (r.status !== 0) return { ok: false, why: "watchdog exit " + r.status + ": " + String(r.stdout || r.stderr || "").trim().slice(0, 300) };
  return { ok: true, why: String(r.stdout || "").trim().slice(0, 200) };
}

/* ---- CLI plumbing ---- */
function parseArgs(argv) {
  const pos = [], flags = {}, bools = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { flags[name] = argv[i + 1]; i++; } else bools.push(name);
    } else pos.push(a);
  }
  return { pos, flags, bools };
}

export function run(argv, cwdRoot) {
  const { pos, flags, bools } = parseArgs(argv);
  const root = path.resolve(flags.root || cwdRoot || process.cwd());
  const ownerToken = !!process.env[OWNER_TOKEN_ENV];
  const now = Date.now();
  const out = (code, text) => { if (text) console.log(text); return code; };
  const cmd = pos[0];

  if (cmd === "issue") {
    const id = pos[1];
    if (!id || !ID_RE.test(id)) return EXIT.USAGE;
    if (!flags.paths || flags.minutes === undefined) return EXIT.USAGE;
    const minutes = Number(flags.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) return EXIT.USAGE;
    let ops = String(flags.ops || "check").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ops.length || !ops.every((o) => OP_RE.test(o))) return EXIT.USAGE;
    if (ops.includes("publish") && !ownerToken) {
      ledgerAppend(root, ledgerLine("DENY", id, { stage: "issue", op: "publish", reason: "OP_NOT_ALLOWED", detail: "no owner token — publish never grantable" }));
      return out(EXIT.DENIED, "DENIED " + id + " reason=OP_NOT_ALLOWED detail=publish requires an owner token; none present");
    }
    const paths = String(flags.paths).split(",").map((s) => s.trim() === "*" ? "*" : normalizePath(s)).filter(Boolean);
    if (!paths.length) return EXIT.USAGE;
    const budget = flags.budget === undefined ? DEFAULT_BUDGET : Number(flags.budget);
    if (!Number.isInteger(budget) || budget < 1) return EXIT.USAGE;
    const singleUse = bools.includes("single-use") || flags.single_use === "1";
    const issued_at = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    const lease = { issued_at, expires_at: new Date(now + minutes * 60000).toISOString().replace(/\.\d+Z$/, "Z"),
      minutes, paths, ops, budget, single_use: singleUse, used_by_op: {}, revoked: false };
    const store = readLeases(root);
    if (store === null) return out(EXIT.DENIED, "DENIED " + id + " reason=NO_LEASE detail=lease store corrupt — fail closed");
    store[id] = lease;
    writeLeases(root, store);
    ledgerAppend(root, ledgerLine("ISSUE", id, { ops: ops.join(","), paths: paths.join(","), minutes, budget, single_use: singleUse ? 1 : 0, expires_at: lease.expires_at }));
    return out(0, "LEASE_OK " + id + " ops=" + ops.join(",") + " paths=" + paths.join(",") + " budget=" + budget +
      " single_use=" + (singleUse ? 1 : 0) + " expires=" + lease.expires_at);
  }

  if (cmd === "touch") {
    const id = pos[1];
    if (!id || !ID_RE.test(id)) return EXIT.USAGE;
    const store = readLeases(root);
    const lease = store && store[id];
    const verdict = evaluate(lease, { op: "touch", now, ownerToken: true });
    if (!verdict.granted && verdict.reason !== "OP_NOT_ALLOWED") {
      ledgerAppend(root, ledgerLine("DENY", id, { stage: "touch", reason: verdict.reason, detail: verdict.detail }));
      return out(EXIT.DENIED, "DENIED " + id + " reason=" + verdict.reason + " detail=" + verdict.detail);
    }
    lease.expires_at = new Date(now + lease.minutes * 60000).toISOString().replace(/\.\d+Z$/, "Z");
    writeLeases(root, store);
    return out(0, "LEASE_TOUCHED " + id + " expires=" + lease.expires_at);
  }

  if (cmd === "check") {
    const id = pos[1];
    const op = flags.op;
    if (!id || !ID_RE.test(id) || !op) return EXIT.USAGE;
    const p = flags.path;
    const store = readLeases(root);
    const lease = store === null ? null : (store[id] || null);
    let verdict = evaluate(lease, { op, p, now, ownerToken });
    if (verdict.granted) {
      const gate = integrityGate(root);
      if (!gate.ok) verdict = { granted: false, reason: "INTEGRITY_FAILED", detail: gate.why, no_grant: true };
    }
    if (!verdict.granted) {
      ledgerAppend(root, ledgerLine("DENY", id, { op, path: p ? normalizePath(p) : "-", reason: verdict.reason, detail: verdict.detail }));
      if (verdict.reason === "INTEGRITY_FAILED") return out(EXIT.DENIED, "NO-GRANT " + id + " op=" + op + " reason=INTEGRITY_FAILED detail=" + verdict.detail);
      return out(EXIT.DENIED, "DENIED " + id + " op=" + op + " reason=" + verdict.reason + " detail=" + verdict.detail);
    }
    lease.used_by_op[op] = (lease.used_by_op[op] || 0) + 1;
    writeLeases(root, store);
    return out(0, "GRANT " + id + " " + verdict.detail);
  }

  if (cmd === "revoke") {
    const id = pos[1], why = pos[2];
    if (!id || !ID_RE.test(id) || !why) return EXIT.USAGE;
    const store = readLeases(root);
    if (!store || !store[id]) { ledgerAppend(root, ledgerLine("DENY", id, { stage: "revoke", reason: "NO_LEASE", detail: why })); return out(EXIT.DENIED, "DENIED " + id + " reason=NO_LEASE"); }
    store[id].revoked = true;
    store[id].revoked_reason = sanitize(why);
    store[id].revoked_at = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    writeLeases(root, store);
    ledgerAppend(root, ledgerLine("REVOKE", id, { reason: why }));
    return out(0, "REVOKED " + id + " reason=" + sanitize(why));
  }

  if (cmd === "status") {
    const store = readLeases(root) || {};
    const halted = existsSync(path.join(root, HALT_SENTINEL));
    const lines = ["authz status  root=" + root + "  halt_sentinel=" + (halted ? "HALTED" : "clear") + "  owner_token=" + (ownerToken ? "present" : "absent")];
    const ids = Object.keys(store).sort();
    if (!ids.length) lines.push("(no leases)");
    for (const id of ids) {
      const l = store[id];
      const used = usedTotal(l);
      const state = l.revoked ? "REVOKED" : (Date.parse(l.expires_at) <= now ? "EXPIRED" : "ACTIVE");
      lines.push(id + " " + state + " ops=" + opList(l).join(",") + " used=" + used + "/" + (l.budget || DEFAULT_BUDGET) +
        " single_use=" + (l.single_use ? 1 : 0) + " expires=" + l.expires_at +
        " used_by_op=" + JSON.stringify(l.used_by_op || {}) + " paths=" + (l.paths || []).join(","));
    }
    lines.push("integrity=" + (integrityGate(root).ok ? "OK" : "FAILED"));
    return out(0, lines.join("\n"));
  }

  return EXIT.USAGE;
}

/** Halt sentinel guard — mirrors the ui_dispatch.txt file-existence pattern. */
export function halted(root) { return existsSync(path.join(root, HALT_SENTINEL)); }

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const a = process.argv.slice(2);
  const cmd = a[0];
  const ri = a.indexOf("--root");
  const root = ri >= 0 ? path.resolve(a[ri + 1]) : repoRoot;
  /* Halt sentinel blocks every state-changing/granting command. status is a read;
   * revoke is the emergency-stop action itself and must always remain available. */
  if (cmd !== "status" && cmd !== "revoke" && halted(root)) {
    ledgerAppend(root, ledgerLine("DENY", a[1] || "?", { stage: String(cmd || "?"), reason: "HALTED", detail: HALT_SENTINEL + " present" }));
    console.log("DENIED " + (a[1] || "?") + " reason=HALTED detail=" + HALT_SENTINEL + " exists — every grant blocked");
    process.exit(EXIT.DENIED);
  }
  process.exit(run(a, repoRoot));
}
