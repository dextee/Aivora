#!/usr/bin/env node
/* guardrail_harness.mjs — WO-05 deterministic enforcement harness (DEV-12, branch-local).
 * Owner-approved tranche B 2026-11-20. NEVER imported by src/ or server/** (runtime-inert by
 * construction; tests/guardrails-harness.test.mjs asserts this). Deterministic exit codes:
 *   0 OK | 1 preflight violation propagated | 2 fail-closed (tool missing/unreadable)
 *   3 unauthorized path for WO class | 4 self-modification refusal | 5 usage
 * Commands:
 *   run-preflight <treeDir> [--json]      — shell out to tools/guardrails_preflight.mjs
 *   allowlist --wo <wo.json> [--changed t] [--simulate f] [--json]
 *                                          — enforce_allowlist semantics; changed file = one path/line;
 *                                            --simulate substitutes the list (drill-only, never commits)
 *   self-check --wo <wo.json> [--changed t] [--json]
 *                                          — refuses to run when a harness-owned enforcement file
 *                                            (SELF_FILES: the harness itself, tools/watchd.mjs, and since
 *                                            WO-09A tools/authz.mjs + tools/verify_integrity.mjs — all four
 *                                            additions are DEV-08-ordered) is in the changed set without a
 *                                            DEV-08-ordered-work-order scope
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const HARNESS_PATH = "tools/guardrail_harness.mjs";
export const WATCHD_PATH = "tools/watchd.mjs";
export const AUTHZ_PATH = "tools/authz.mjs";                 // WO-09A (DEV-08 ordered)
export const WATCHDOG_PATH = "tools/verify_integrity.mjs";   // WO-09A (DEV-08 ordered)
export const SELF_FILES = [HARNESS_PATH, WATCHD_PATH, AUTHZ_PATH, WATCHDOG_PATH];
export const PREFLIGHT_PATH = "tools/guardrails_preflight.mjs";
export const EXIT = { OK: 0, PREFLIGHT_FAILED: 1, FAIL_CLOSED: 2, UNAUTHORIZED_PATH: 3, SELF_MODIFICATION: 4, USAGE: 5 };
/* Runtime surfaces frozen for security-class WOs (WO-05/06/07). The src/ prefix covers nested dirs too. */
export const RUNTIME_FROZEN = [{ prefix: "src/" }, { exact: "index.html" }, { exact: "package.json" }, { exact: "package-lock.json" }, { exact: "vite.config.ts" }, { exact: "server.mjs" }, { prefix: "server/" }];
export const SECURITY_ROLES = new Set(["DEV-08-ordered-work-order", "security-WO"]);

const normalize = (p) => String(p || "").trim().replace(/^\.\//, "").replace(/\\/g, "/");
const pfx = (w) => (w.prefix ? { test: (p) => p.startsWith(w.prefix) } : { test: (p) => p === w.exact });
const matches = (p, w) => pfx(w).test(p);

/** Core rule — pure function; harness CLI and drills both exercise this same code path. */
export function enforce_allowlist(changedFiles, woScope, classOverride) {
  const changed = (changedFiles || []).map(normalize).filter(Boolean);
  const cls = classOverride || woScope?.class || "security-WO";
  const violations = [];
  if (changed.length === 0) return { ok: false, level: "FAIL_CLOSED", violations: ["empty changed-file list — refusing to certify nothing"] };
  for (const f of changed) {
    if (matches(f, { prefix: "node_modules/" }) || matches(f, { prefix: "dist/" }) || matches(f, { prefix: ".qw-pages/" }) || matches(f, { prefix: ".git/" }))
      violations.push({ file: f, rule: "generated/vendored path never certifiable" });
  }
  if (SECURITY_ROLES.has(cls)) {
    for (const f of changed) {
      const frozen = RUNTIME_FROZEN.find((w) => matches(f, w));
      if (frozen) violations.push({ file: f, rule: "security-class WO may not touch runtime surface " + (frozen.prefix || frozen.exact) });
    }
    for (const t of woScope?.targets || []) {
      const aliasable = RUNTIME_FROZEN.some((w) => t.prefix ? (w.prefix && t.prefix.startsWith(w.prefix)) : (w.exact && (w.prefix ? w.prefix.startsWith(t.exact + "/") : w.exact === t.exact)));
      if (aliasable) violations.push({ file: t, rule: "WO scope attempts to widen a frozen runtime surface (scope forgery — cf. F-1 forged-scope pattern)" });
    }
  }
  const allowed = (woScope?.paths || []).map(normalize);
  for (const f of changed) {
    if (violations.some((v) => v.file === f)) continue;
    if (SELF_FILES.includes(f)) continue; // self-files handled exclusively by selfCheck()
    if (!allowed.some((a) => a === f || (a.endsWith("/") && f.startsWith(a))))
      violations.push({ file: f, rule: "outside WO scope" });
  }
  return { ok: violations.length === 0, level: violations.length ? "UNAUTHORIZED_PATH" : "OK", violations };
}

/** Refuse to run when a harness-owned enforcement file is in the changed set without proper ordering. */
export function selfCheck(changedFiles, wo) {
  const changed = (changedFiles || []).map(normalize);
  const selfHits = changed.filter((f) => SELF_FILES.includes(f));
  if (selfHits.length === 0) return { ok: true, level: "OK", violations: [] };
  const targets = (wo?.targets || []).map(normalize);
  const sanctioned = wo?.role === "DEV-08-ordered-work-order" && selfHits.every((f) => targets.includes(f));
  if (sanctioned) return { ok: true, level: "OK", violations: selfHits.map((f) => ({ file: f, rule: "SELF-MOD SANCTIONED by DEV-08 ordered work order — proceed with eyes open" })), sanctioned_self_mod: true };
  return { ok: false, level: "SELF_MODIFICATION", violations: selfHits.map((f) => ({ file: f, rule: "harness refuses to run: enforcement file in changed set and role != DEV-08-ordered-work-order (or not every self-file is an explicit target)" })) };
}

function loadJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

function main(argv) {
  const cmd = argv[0];
  const flagVal = (name, args = argv) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const has = (name, args = argv) => args.includes(name);
  const out = (obj, code) => { if (has("--json")) console.log(JSON.stringify(obj)); process.exit(code); };
  if (cmd === "run-preflight") {
    const tree = argv[1] || ".";
    const tool = path.join(tree, "tools/guardrails_preflight.mjs");
    if (!existsSync(tool)) return out({ cmd, tree, level: "FAIL_CLOSED", reason: "preflight tool absent — enforcement infrastructure missing; assume the worst and block" }, EXIT.FAIL_CLOSED);
    const r = spawnSync(process.execPath, [tool, tree], { encoding: "utf8" });
    if (r.error) return out({ cmd, tree, level: "FAIL_CLOSED", reason: "preflight unrunnable: " + r.error.message }, EXIT.FAIL_CLOSED);
    if (r.status === 0) return out({ cmd, tree, level: "OK", stdout: r.stdout.trim() }, EXIT.OK);
    return out({ cmd, tree, level: "PREFLIGHT_FAILED", stderr: r.stderr.trim(), reason: r.stderr.trim() || String(r.status) }, EXIT.PREFLIGHT_FAILED);
  }
  if (cmd === "allowlist" || cmd === "self-check") {
    const woPath = flagVal("--wo"); const changedPath = flagVal("--changed"); const simPath = flagVal("--simulate");
    if (!woPath || (!changedPath && !simPath)) return out({ cmd, level: "FAIL_CLOSED", reason: "usage: --wo <file> and (--changed <file> | --simulate <file>)" }, EXIT.USAGE);
    let wo, changed;
    try { wo = loadJson(woPath); } catch (e) { return out({ cmd, level: "FAIL_CLOSED", reason: "WO unreadable: " + e.message }, EXIT.FAIL_CLOSED); }
    try { changed = readFileSync(simPath || changedPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); }
    catch (e) { return out({ cmd, level: "FAIL_CLOSED", reason: "changed list unreadable: " + e.message }, EXIT.FAIL_CLOSED); }
    if (cmd === "self-check") {
      const sc = selfCheck(changed, wo);
      if (!sc.ok) return out({ cmd, level: sc.level, self_check: sc }, EXIT.SELF_MODIFICATION);
      const al = enforce_allowlist(changed, { paths: [...(wo.paths || []), ...(wo.targets || [])] }, wo.role);
      if (!al.ok) return out({ cmd, level: al.level, self_check: sc, allowlist: al }, EXIT.UNAUTHORIZED_PATH);
      return out({ cmd, level: "OK", self_check: sc, allowlist: al }, EXIT.OK);
    }
    const sc = selfCheck(changed, wo);
    if (!sc.ok) return out({ cmd, level: sc.level, reason: "self-mod refusal precedes allowlist evaluation", self_check: sc }, EXIT.SELF_MODIFICATION);
    const res = enforce_allowlist(changed, wo.scope || wo, wo.role === "DEV-08-ordered-work-order" ? "security-WO" : undefined);
    if (!res.ok) return out({ cmd, level: res.level, allowlist: res, simulate: !!simPath }, EXIT.UNAUTHORIZED_PATH);
    return out({ cmd, level: "OK", allowlist: res, simulate: !!simPath }, EXIT.OK);
  }
  return out({ level: "USAGE", reason: "unknown command: " + cmd }, EXIT.USAGE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
