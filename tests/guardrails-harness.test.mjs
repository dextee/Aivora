/* guardrails-harness.test.mjs — WO-05 enforcement drills (DEV-12). All branch-local:
 * these tests import ONLY tools/guardrail_harness.mjs and the preflight tool as a subprocess;
 * no runtime module ever imports the harness (inertness itself is Drill F below). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enforce_allowlist, selfCheck, HARNESS_PATH, WATCHD_PATH, SELF_FILES, PREFLIGHT_PATH, EXIT } from "../tools/guardrail_harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(repoRoot, "tools/guardrail_harness.mjs");

const run = (args) => spawnSync(process.execPath, [HARNESS, ...args], { encoding: "utf8" });
const json = (r) => JSON.parse(r.stdout);

function scratchTree(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wo05-scratch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ["server.mjs", "package.json", "src/main.tsx", PREFLIGHT_PATH, "server/odai/policy.mjs", "server/odai/workflow.mjs"])
    cpSync(path.join(repoRoot, f), path.join(dir, f), { recursive: true });
  return dir;
}

// ---- deterministic pure-function behavior -------------------------------------------------
test("harness unit: enforce_allowlist freezes runtime surfaces for security WOs", () => {
  const wo = { paths: ["tools/", "tests/", "odai/dev_docs/"] };
  assert.equal(enforce_allowlist(["tools/x.mjs", "odai/dev_docs/r.md"], wo).ok, true);
  for (const bad of ["src/main.tsx", "index.html", "package.json", "package-lock.json", "vite.config.ts", "server.mjs", "server/odai/policy.mjs"])
    assert.equal(enforce_allowlist([bad], wo).ok, false, bad + " must be frozen for security-class WOs");
  assert.equal(enforce_allowlist([], wo).ok, false, "empty changed set must fail closed");
  assert.equal(enforce_allowlist(["src/App.tsx"], { paths: ["src/"] }, "ui-WO").ok, true, "non-security class is not frozen (class distinction is real)");
  assert.equal(enforce_allowlist(["x"], { paths: ["x"], targets: [{ prefix: "src/" }] }, "security-WO").ok, false, "scope forgery (frozen alias in targets) rejected — F-1 pattern");
});

test("harness unit: selfCheck gates enforcement-owned files, only passable via DEV-08 ordering", () => {
  assert.equal(selfCheck(["src/x.tsx"], {}).ok, true, "no self-file → silent pass to normal flow");
  assert.equal(selfCheck([HARNESS_PATH], { role: "security-WO" }).ok, false);
  assert.equal(selfCheck([WATCHD_PATH], { role: "reviewer" }).ok, false, "watchd is enforcement-owned too (WO-6 ordering)");
  assert.equal(selfCheck([HARNESS_PATH, WATCHD_PATH], { role: "DEV-08-ordered-work-order", targets: [HARNESS_PATH] }).ok, false, "ordered but not targeting every self-file in the set → still refuse");
  const sanctioned = selfCheck([HARNESS_PATH, WATCHD_PATH], { role: "DEV-08-ordered-work-order", targets: [HARNESS_PATH, WATCHD_PATH] });
  assert.equal(sanctioned.ok, true);
  assert.equal(sanctioned.sanctioned_self_mod, true);
});

// ---- Drill A: duplicate policy evaluator copy on scratch tree → preflight fails closed ----
test("drill A: duplicate policy evaluator on scratch tree exits non-zero", (t) => {
  const dir = scratchTree(t);
  assert.equal(run(["run-preflight", dir, "--json"]).status, EXIT.OK, "baseline scratch tree must be clean");
  const pol = path.join(dir, "server/odai/policy.mjs");
  writeFileSync(pol, readFileSync(pol, "utf8") + "\nexport function evaluate(dup) { return dup; } // WO-05 drill A duplicate copy\n");
  const r = run(["run-preflight", dir, "--json"]);
  assert.equal(r.status, EXIT.PREFLIGHT_FAILED);
  assert.match(json(r).stderr, /multiple policy evaluators/);
});

// ---- Drill B: provenance-import injection into scratch server.mjs → G5 fires --------------
test("drill B: provenance/evidence import injected into scratch server.mjs exits non-zero", (t) => {
  const dir = scratchTree(t);
  const s = path.join(dir, "server.mjs");
  writeFileSync(s, 'import evidence from "./odai/dev_docs/evidence/V39.json"; // source-review probe\n' + readFileSync(s, "utf8"));
  const r = run(["run-preflight", dir, "--json"]);
  assert.equal(r.status, EXIT.PREFLIGHT_FAILED);
  assert.match(json(r).stderr, /G5 violated/);
});

// ---- Drill C: preflight tool itself missing → harness fails CLOSED ------------------------
test("drill C: missing preflight tool yields fail-closed exit 2", (t) => {
  const dir = scratchTree(t);
  rmSync(path.join(dir, PREFLIGHT_PATH));
  const r = run(["run-preflight", dir, "--json"]);
  assert.equal(r.status, EXIT.FAIL_CLOSED);
  assert.equal(json(r).level, "FAIL_CLOSED");
});

// ---- Drill D: unauthorized-path simulation via allowlist enforcement ----------------------
test("drill D: allowlist simulation rejects src/, index.html, package.json for security WOs; accepts scoped paths", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wo05-sim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const woPath = path.join(dir, "wo.json");
  writeFileSync(woPath, JSON.stringify({ class: "security-WO", scope: { paths: ["tools/", "tests/", "odai/dev_docs/"] } }));
  const sim = (name, lines) => { const p = path.join(dir, name); writeFileSync(p, lines.join("\n") + "\n"); return p; };
  for (const forbidden of ["src/App.tsx", "src/odai/policy-copy.mjs", "index.html", "package.json"]) {
    const r = run(["allowlist", "--wo", woPath, "--simulate", sim("bad.txt", [forbidden, "tools/release_evidence.mjs"]), "--json"]);
    assert.equal(r.status, EXIT.UNAUTHORIZED_PATH, forbidden);
    const out = json(r);
    assert.ok(out.simulate, "evidence recorded as simulation only");
    assert.ok(out.allowlist.violations.some((v) => v.file === forbidden));
  }
  const ok = run(["allowlist", "--wo", woPath, "--simulate", sim("ok.txt", ["tools/release_evidence.mjs", "tests/guardrails-harness.test.mjs", "odai/dev_docs/wo05.md"]), "--json"]);
  assert.equal(ok.status, EXIT.OK);
});

// ---- Drill E: agent self-modification — fixture WO parsing -------------------------------
test("drill E: harness refuses to run when its own file is in changed set without DEV-08 ordering; sanctioned fixture passes", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wo05-self-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const changedPath = path.join(dir, "changed.txt");
  writeFileSync(changedPath, SELF_FILES.join("\n") + "\n");
  const rogue = path.join(dir, "rogue-wo.json");
  writeFileSync(rogue, JSON.stringify({ role: "security-WO", paths: ["tools/"] }));
  const r1 = run(["self-check", "--wo", rogue, "--changed", changedPath, "--json"]);
  assert.equal(r1.status, EXIT.SELF_MODIFICATION);
  assert.equal(json(r1).level, "SELF_MODIFICATION");
  const ordered = path.join(dir, "ordered-wo.json");
  writeFileSync(ordered, JSON.stringify({ role: "DEV-08-ordered-work-order", targets: [...SELF_FILES], paths: ["odai/dev_docs/"] }));
  const r2 = run(["self-check", "--wo", ordered, "--changed", changedPath, "--json"]);
  assert.equal(r2.status, EXIT.OK);
  assert.equal(json(r2).self_check.sanctioned_self_mod, true);
});

// ---- Drill F: runtime inertness — the added branch must never be imported ----------------
test("drill F: harness+watchd are branch-local — no runtime import, and both import only node builtins", () => {
  for (const self of SELF_FILES) {
    const src = readFileSync(path.join(repoRoot, self), "utf8");
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g))
      assert.match(m[1], /^node:/, self + " must only import node builtins, found " + m[1]);
  }
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  for (const dir of [path.join(repoRoot, "server"), path.join(repoRoot, "src")]) walk(dir);
  files.push(path.join(repoRoot, "server.mjs"));
  for (const f of files)
    assert.doesNotMatch(readFileSync(f, "utf8"), /guardrail_harness|watchd/, "runtime file imports a WO-05/06 enforcement module: " + path.relative(repoRoot, f));
});
