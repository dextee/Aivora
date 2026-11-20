#!/usr/bin/env node
/* release_evidence.mjs — WO-04 (DEV-11)
 * Writes odai/dev_docs/evidence/<version>.json capturing:
 *   { at, commit_oid_head, dist: [{name, sha256}], npm_test: {tests, pass, fail, tap_tail}, page_version, notes }
 * npm test summary is captured from the TAP tail (real run, never copied from memory).
 * Read-only w.r.t. Git/Page APIs; writes only under odai/dev_docs/evidence/.
 * Usage: node tools/release_evidence.mjs <VERSION> ["notes"]
 *   VERSION may also be discovered by the operator from page_repo.py resolve before calling.
 */
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [version = null, notes = "release evidence (WO-04)"] = process.argv.slice(2);
if (!version) { console.error("usage: node tools/release_evidence.mjs <VERSION> [\"notes\"]"); process.exit(1); }
const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const dist = walk(join(root, "dist")).map((f) => ({
  name: relative(root, f).split("\\").join("/"),
  sha256: createHash("sha256").update(readFileSync(f)).digest("hex"),
})).sort((a, b) => a.name.localeCompare(b.name));

const commit_oid_head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();

const t = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const out = (t.stdout || "") + "\n" + (t.stderr || "");
const grab = (re) => +(out.match(re)?.[1] ?? NaN);
const npm_test = {
  exit: t.status,
  tests: grab(/^# tests (\d+)/m),
  pass: grab(/^# pass (\d+)/m),
  fail: grab(/^# fail (\d+)/m),
  skipped: grab(/^# skipped (\d+)/m),
  duration_ms: grab(/^# duration_ms ([\d.]+)/m),
  tap_tail: out.trim().split("\n").filter((l) => l.startsWith("#")).slice(-12).join("\n"),
};
if (t.status !== 0 || Number.isNaN(npm_test.pass) || npm_test.pass !== npm_test.tests || npm_test.fail !== 0) {
  console.error("refusing to certify evidence: npm test not fully green (exit " + t.status + ")");
  console.error(npm_test.tap_tail);
  process.exit(1);
}

const evidence = { at: new Date().toISOString(), commit_oid_head, dist, npm_test, page_version: version, notes };
const dir = join(root, "odai/dev_docs/evidence");
mkdirSync(dir, { recursive: true });
const file = join(dir, version + ".json");
writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
console.log("wrote " + relative(root, file) + " · commit " + commit_oid_head.slice(0, 8) + " · dist assets " + dist.length + " · tests " + npm_test.pass + "/" + npm_test.tests + " pass, " + npm_test.fail + " fail");
