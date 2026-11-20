#!/usr/bin/env node
/* guardrails_preflight.mjs — DEV-12-SK-01 (Rev 2.1, hash 264121e2…bf733)
 * Run BEFORE every mutation and again at dispatch. Exit 0 = cleared; non-zero + reason = mutation forbidden for this attempt. */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
const root = process.argv[2] || "."; const fail = [];
const read = (p) => { try { return readFileSync(root + "/" + p, "utf8"); } catch { return null; } };
const s = read("server.mjs");
if (s === null) fail.push("server.mjs missing — wrong repo root?");
else {
  const listeners = (s.match(/server\.listen\(/g) || []).length;
  if (listeners !== 1) fail.push("G1 violated: " + listeners + " servers in entrypoint");
  if (/from\s+["'][^"']*v3_review|source-review/.test(s)) fail.push("G5 violated: provenance JSON imported into runtime");
}
if (existsSync(root + "/.qwenwork") || existsSync(root + "/odai/v3")) if (read("package-lock.json") === null) fail.push("G4: lockfile absent");
const pol = read("server/odai/policy.mjs"); if (pol && (pol.match(/export function evaluate/g) || []).length !== 1) fail.push("G1: multiple policy evaluators");
if (read("src/main.tsx") === null) fail.push("G3: editable frontend source missing");
const tests = read("package.json"); if (tests && !/runtime\.test\.mjs/.test(tests)) fail.push("test gate detached from npm test");
const wf = read("server/odai/workflow.mjs") || "";
if (wf && (wf.match(/export async function startRun/g) || []).length !== 1) fail.push("G1: second dispatcher detected in workflow module");
if (fail.length) { console.error("PREFLIGHT FAIL:\n - " + fail.join("\n - ")); process.exit(1); }
console.log("preflight clear: single-server ✓ provenance-inert ✓ lockfile ✓ single-policy ✓ editable-src ✓ test-gate ✓ single-dispatcher ✓");
