#!/usr/bin/env node
/* verify_integrity.mjs — WO-09A watchdog: seals and verifies the enforcement-file manifest.
 * Branch-local: node builtins only, never imported by src/** or server/**.
 *
 *   seal  [--root dir]   — hash every protected file into tools/SECURITY-FILES.sha256 (build time)
 *   check [--root dir]   — exit 0 only when EVERY protected file matches its sealed sha256
 *
 * FAIL-CLOSED CONTRACT: any mismatch, any missing protected file, an unreadable or absent
 * manifest, or an unparsable manifest ⇒ exit 1 (a missing manifest is a FAIL, never a pass).
 * tools/authz.mjs runs `check` before it grants anything, so a tampered watchdog means NO-GRANT.
 *
 * CONVENTION (owner-enforced, audited by tools/watchd.mjs externally): the six files below are
 * the security-critical surface and must never be edited without an owner token:
 *   tools/authz.mjs · tools/verify_integrity.mjs · tools/guardrails_preflight.mjs
 *   tools/guardrail_harness.mjs · tests/authz.test.mjs · tools/SECURITY-FILES.sha256 (the seal)
 * Exit codes: 0 OK | 1 FAIL (mismatch/missing/unreadable) | 5 usage.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = "tools/SECURITY-FILES.sha256";
export const PROTECTED_FILES = [
  ".githooks/pre-commit",
  "tools/authz.mjs",
  "tools/verify_integrity.mjs",
  "tools/guardrails_preflight.mjs",
  "tools/guardrail_harness.mjs",
  "tests/authz.test.mjs",
];
export const HEADER = "# WO-09A security-file seal — never edit these files without an owner token (tools/watchd.mjs audits this list)";
export const EXIT = { OK: 0, FAIL: 1, USAGE: 5 };

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Deterministic manifest text: header, then `<sha256>  <relpath>` rows sorted by path. */
export function sealText(read) {
  const rows = [...PROTECTED_FILES].sort().map((f) => sha256(read(f)) + "  " + f);
  return [HEADER, ...rows, ""].join("\n");
}

export function parseManifest(text) {
  const lines = String(text).split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const map = new Map();
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{64})  (\S+)$/);
    if (!m) throw new Error("unparsable manifest row: " + l.slice(0, 80));
    map.set(m[2], m[1]);
  }
  return map;
}

/** Pure comparison — returns {ok, problems[]}. Never throws for missing/unreadable inputs. */
export function compare(manifestText, read) {
  const problems = [];
  if (manifestText === null) return { ok: false, problems: ["manifest missing — " + MANIFEST_PATH + " (missing seal = FAIL, fail-closed)"] };
  let map;
  try { map = parseManifest(manifestText); } catch (e) { return { ok: false, problems: ["manifest unparsable — " + e.message] }; }
  for (const f of [...PROTECTED_FILES].sort()) {
    let buf;
    try { buf = read(f); } catch (e) { problems.push("UNREADABLE " + f + " (" + (e.code || e.message) + ")"); continue; }
    const want = map.get(f);
    if (!want) { problems.push("NOT_SEALED " + f + " (protected file absent from manifest)"); continue; }
    const got = sha256(buf);
    if (got !== want) problems.push("MISMATCH " + f + " sealed=" + want.slice(0, 16) + "… actual=" + got.slice(0, 16) + "…");
  }
  const extra = [...map.keys()].filter((k) => !PROTECTED_FILES.includes(k));
  for (const f of extra) problems.push("STALE_ROW " + f + " (in manifest, no longer a protected file)");
  return { ok: problems.length === 0, problems };
}

function argVal(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export function main(argv) {
  const mode = argv[0];
  const root = path.resolve(argVal(argv, "--root") || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const manifestAbs = path.join(root, MANIFEST_PATH);
  const rel = (f) => path.join(root, f);
  const reader = (f) => readFileSync(rel(f));
  if (mode === "seal") {
    const missing = PROTECTED_FILES.filter((f) => !existsSync(path.join(root, f)));
    if (missing.length) { console.log("SEAL REFUSED — protected file missing:\n - " + missing.join("\n - ")); return EXIT.FAIL; }
    const text = sealText(reader);
    mkdirSync(path.dirname(manifestAbs), { recursive: true });
    const tmp = manifestAbs + ".tmp";
    writeFileSync(tmp, text);
    renameSync(tmp, manifestAbs);
    console.log("SEALED " + PROTECTED_FILES.length + " files -> " + MANIFEST_PATH + " @ " + root);
    return EXIT.OK;
  }
  if (mode === "check") {
    const before = existsSync(manifestAbs) ? (() => { try { return readFileSync(manifestAbs, "utf8"); } catch { return null; } })() : null;
    if (before === null) {
      console.log("INTEGRITY FAIL (1):");
      console.log(" - manifest missing or unreadable — " + MANIFEST_PATH + " (missing seal = FAIL, fail-closed)");
      return EXIT.FAIL;
    }
    const r = compare(before, reader);
    if (!r.ok) {
      console.log("INTEGRITY FAIL (" + r.problems.length + "):");
      for (const p of r.problems) console.log(" - " + p);
      return EXIT.FAIL;
    }
    console.log("INTEGRITY OK: " + PROTECTED_FILES.length + " sealed enforcement files verified");
    return EXIT.OK;
  }
  console.error("usage: node tools/verify_integrity.mjs seal|check [--root dir]");
  return EXIT.USAGE;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
