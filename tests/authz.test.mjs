/* authz.test.mjs — WO-09A security remediation proofs (DEV-08/DEV-10 build, DEV-12 verification).
 * One test per the six named failures, plus the pure-decision and inertness proofs.
 * Everything runs in a throwaway FIXTURE tree (copy of the six security files + its own seal
 * + own leases.json/authz-ledger.txt): the live repo tools, manifest, lease store and ledger
 * are NEVER mutated by this suite. Branch-local: only node builtins are imported here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, pathAllowed, ledgerLine, DENIAL_REASONS, EXIT, LEASES_FILE, LEDGER_FILE, HALT_SENTINEL } from "../tools/authz.mjs";
import { PROTECTED_FILES, compare, sha256 } from "../tools/verify_integrity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHZ_REL = "tools/authz.mjs";
const WATCHDOG_REL = "tools/verify_integrity.mjs";
const MANIFEST_REL = "tools/SECURITY-FILES.sha256";

/* ---- fixture harness ---- */
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wo09a-"));
  t.after(() => {
    try { chmodSync(path.join(dir, MANIFEST_REL), 0o644); } catch { /* mode restored for rm only */ }
    try { chmodSync(path.join(dir, LEASES_FILE), 0o644); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const f of PROTECTED_FILES) {
    const src = path.join(repoRoot, f);
    if (!existsSync(src)) throw new Error("security file missing from repo, cannot certify: " + f);
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(src, path.join(dir, f));
  }
  const sealed = spawnSync(process.execPath, [path.join(dir, WATCHDOG_REL), "seal", "--root", dir], { encoding: "utf8" });
  assert.equal(sealed.status, 0, "fixture seal must succeed: " + sealed.stderr);
  return dir;
}
const authz = (dir, args, env = {}) => spawnSync(process.execPath, [path.join(dir, AUTHZ_REL), ...args, "--root", dir],
  { encoding: "utf8", env: { ...process.env, ...env } });
const watchdog = (dir, mode = "check") => spawnSync(process.execPath, [path.join(dir, WATCHDOG_REL), mode, "--root", dir], { encoding: "utf8" });
const ledger = (dir) => (existsSync(path.join(dir, LEDGER_FILE)) ? readFileSync(path.join(dir, LEDGER_FILE), "utf8") : "").split("\n").filter(Boolean);
const ledgerFor = (dir, id) => ledger(dir).filter((l) => l.split("|")[2] === id);
const store = (dir) => JSON.parse(readFileSync(path.join(dir, LEASES_FILE), "utf8"));

/* ======================================================================================
 * [1] REFUSES TO STOP — an expired lease cannot act: check exits 2 with EXPIRED.
 * ===================================================================================== */
test("scenario 1 refuses-to-stop: expired lease (--minutes 0) is denied with EXPIRED and a ledger line", (t) => {
  const dir = fixture(t);
  const issued = authz(dir, ["issue", "WO-09-S1", "--paths", "tools/,tests/,odai/dev_docs/", "--minutes", "0", "--ops", "check,commit"]);
  assert.equal(issued.status, 0, issued.stdout + issued.stderr);
  const chk = authz(dir, ["check", "WO-09-S1", "--op", "check"]);
  assert.equal(chk.status, EXIT.DENIED, "expired lease must exit 2 — " + chk.stdout);
  assert.match(chk.stdout, /reason=EXPIRED/);
  const lines = ledgerFor(dir, "WO-09-S1");
  assert.equal(lines[0].split("|")[1], "ISSUE");
  assert.match(lines[lines.length - 1], /^\d{4}-\d\d-\d\dT[\d:]+Z\|DENY\|WO-09-S1\|op=check\|path=-\|reason=EXPIRED\|detail=expires_at=/);
  assert.equal(store(dir)["WO-09-S1"].used_by_op.check || 0, 0, "a denied check consumes nothing");
});

/* ======================================================================================
 * [2] OVER BUDGET — the 13th check on a 12-op lease is denied with OVER_BUDGET.
 * ===================================================================================== */
test("scenario 2 over-budget: 12 granted checks, the 13th exits 2 OVER_BUDGET (budget is enforced, not decorative)", (t) => {
  const dir = fixture(t);
  assert.equal(authz(dir, ["issue", "WO-09-S2", "--paths", "tools/", "--minutes", "60"]).status, 0);
  for (let i = 1; i <= 12; i++) {
    const g = authz(dir, ["check", "WO-09-S2", "--op", "check"]);
    assert.equal(g.status, 0, "check #" + i + " must be granted — " + g.stdout);
    assert.match(g.stdout, /^GRANT WO-09-S2/);
  }
  assert.equal(store(dir)["WO-09-S2"].used_by_op.check, 12);
  const over = authz(dir, ["check", "WO-09-S2", "--op", "check"]);
  assert.equal(over.status, EXIT.DENIED, "13th check must exit 2 — " + over.stdout);
  assert.match(over.stdout, /reason=OVER_BUDGET/);
  assert.match(over.stdout, /used=12\/12/);
  assert.equal(ledgerFor(dir, "WO-09-S2").filter((l) => l.includes("|DENY|")).length, 1, "grants never hit the ledger; the denial does");
  assert.match(ledgerFor(dir, "WO-09-S2").at(-1), /reason=OVER_BUDGET\|detail=used=12\/12/);
  assert.equal(store(dir)["WO-09-S2"].used_by_op.check, 12, "over-budget denial does not inflate usage");
});

/* ======================================================================================
 * [3] UNAUTHORIZED PUBLISH — never grantable without an owner token.
 * ===================================================================================== */
test("scenario 3 unauthorized publish: check --op publish exits 2 OP_NOT_ALLOWED and publish cannot even be issued tokenless", (t) => {
  const dir = fixture(t);
  assert.equal(process.env.ODAI_OWNER_TOKEN, undefined, "test run must carry no owner token");
  assert.equal(authz(dir, ["issue", "WO-09-S3", "--paths", "tools/,dist/", "--minutes", "60", "--ops", "check,commit"]).status, 0);
  const pub = authz(dir, ["check", "WO-09-S3", "--op", "publish"]);
  assert.equal(pub.status, EXIT.DENIED, "publish check must exit 2 — " + pub.stdout);
  assert.match(pub.stdout, /reason=OP_NOT_ALLOWED/);
  const forged = authz(dir, ["issue", "WO-09-S3b", "--paths", "dist/", "--minutes", "60", "--ops", "check,publish"]);
  assert.equal(forged.status, EXIT.DENIED, "tokenless issue asking for publish is refused outright — " + forged.stdout);
  assert.match(forged.stdout, /reason=OP_NOT_ALLOWED/);
  assert.ok(!("WO-09-S3b" in store(dir)), "refused issue writes no lease");
  assert.match(ledger(dir).join("\n"), /DENY\|WO-09-S3b\|stage=issue\|op=publish\|reason=OP_NOT_ALLOWED/);
  assert.match(ledgerFor(dir, "WO-09-S3").at(-1), /\|DENY\|WO-09-S3\|op=publish\|.*reason=OP_NOT_ALLOWED/);
});

/* ======================================================================================
 * [4] DISABLED WATCHDOG — tampering is done to a FIXTURE COPY only; the repo tool is
 *     byte-for-byte verified untouched afterwards. Tampered watchdog ⇒ integrity FAIL ⇒
 *     authz check grants nothing (NO-GRANT).
 * ===================================================================================== */
test("scenario 4 disable-watchdog: tampered fixture watchdog fails integrity (exit 1) and authz check yields NO-GRANT (exit 2); repo tool untouched", (t) => {
  const dir = fixture(t);
  const repoBefore = sha256(readFileSync(path.join(repoRoot, WATCHDOG_REL)));
  assert.equal(watchdog(dir).status, 0, "fixture baseline must be integrity-clean");
  assert.equal(authz(dir, ["issue", "WO-09-S4", "--paths", "tools/", "--minutes", "60"]).status, 0);
  const p = path.join(dir, WATCHDOG_REL);
  writeFileSync(p, readFileSync(p, "utf8").replace('console.log("INTEGRITY OK: "', 'console.log("INTEGRITY OK (tampered): "'));
  const bad = watchdog(dir);
  assert.equal(bad.status, 1, "tampered watchdog must exit 1 — " + bad.stdout);
  assert.match(bad.stdout, /MISMATCH tools\/verify_integrity\.mjs/);
  assert.match(bad.stdout, /INTEGRITY FAIL \(1\):/, "one tampered file, one reported problem — no silent extra damage");
  assert.doesNotMatch(bad.stdout, /MISMATCH tools\/authz\.mjs/, "untouched files must still match their seal");
  const chk = authz(dir, ["check", "WO-09-S4", "--op", "check", "--path", "tools/authz.mjs"]);
  assert.equal(chk.status, EXIT.DENIED, "integrity failure must never grant — " + chk.stdout);
  assert.match(chk.stdout, /^NO-GRANT/);
  assert.match(chk.stdout, /reason=INTEGRITY_FAILED/);
  assert.match(ledgerFor(dir, "WO-09-S4").at(-1), /reason=INTEGRITY_FAILED/);
  assert.equal(store(dir)["WO-09-S4"].used_by_op.check || 0, 0, "a NO-GRANT check consumes nothing");
  assert.equal(sha256(readFileSync(path.join(repoRoot, WATCHDOG_REL))), repoBefore, "the REPO watchdog was never touched");
});

/* ======================================================================================
 * [5] WATCHDOG/POLICY UNAVAILABLE — manifest unreadable (chmod 000 in fixture) or absent:
 *     both fail closed with a non-zero exit.
 * ===================================================================================== */
test("scenario 5 watchdog-unavailable: unreadable seal exits non-zero fail-closed and no grant is possible; missing seal also FAILs", (t) => {
  const dir = fixture(t);
  assert.equal(authz(dir, ["issue", "WO-09-S5", "--paths", "tools/", "--minutes", "60"]).status, 0);
  const m = path.join(dir, MANIFEST_REL);
  chmodSync(m, 0o000);
  const w = watchdog(dir);
  assert.notEqual(w.status, 0, "unreadable seal must not report OK — " + w.stdout);
  assert.equal(w.status, 1);
  assert.match(w.stdout, /manifest missing or unreadable/);
  const chk = authz(dir, ["check", "WO-09-S5", "--op", "check"]);
  assert.notEqual(chk.status, 0, "no grant when the watchdog cannot run — " + chk.stdout);
  assert.equal(chk.status, EXIT.DENIED);
  assert.match(chk.stdout, /reason=INTEGRITY_FAILED/);
  chmodSync(m, 0o644);
  rmSync(m);
  const gone = watchdog(dir);
  assert.equal(gone.status, 1, "missing manifest is a FAIL, never a pass");
  assert.match(gone.stdout, /missing seal = FAIL/);
  assert.equal(authz(dir, ["check", "WO-09-S5", "--op", "check"]).status, EXIT.DENIED);
});

/* ======================================================================================
 * [6] RESUME WITHOUT AUTHORIZATION — a single-use lease cannot be replayed: CONSUMED_RESUME.
 * ===================================================================================== */
test("scenario 6 resume-without-authorization: consuming the single-use check then re-checking exits 2 CONSUMED_RESUME", (t) => {
  const dir = fixture(t);
  assert.equal(authz(dir, ["issue", "WO-09-S6", "--paths", "tools/", "--minutes", "60", "--ops", "check", "--budget", "12", "--single-use"]).status, 0);
  const first = authz(dir, ["check", "WO-09-S6", "--op", "check"]);
  assert.equal(first.status, 0, "first use is granted — " + first.stdout);
  assert.match(first.stdout, /^GRANT/);
  const resume = authz(dir, ["check", "WO-09-S6", "--op", "check"]);
  assert.equal(resume.status, EXIT.DENIED, "replay after consumption must exit 2 — " + resume.stdout);
  assert.match(resume.stdout, /reason=CONSUMED_RESUME/);
  assert.match(ledgerFor(dir, "WO-09-S6").at(-1), /\|DENY\|WO-09-S6\|op=check\|path=-\|reason=CONSUMED_RESUME\|detail=single-use lease already consumed/);
  assert.equal(store(dir)["WO-09-S6"].used_by_op.check, 1, "replay does not double-consume");
  const otherOp = authz(dir, ["revoke", "WO-09-S6", "owner_closed_single_use_lease"]);
  assert.equal(otherOp.status, 0);
  assert.match(authz(dir, ["check", "WO-09-S6", "--op", "check"]).stdout, /reason=REVOKED/, "revocation outranks every other state");
});

/* ======================================================================================
 * halt sentinel + store hygiene (the ui_dispatch.txt guard pattern, reused)
 * ===================================================================================== */
test("halt sentinel: odai/dev_docs/HALT present ⇒ HALTED before any grant, and revoke still works to close leases", (t) => {
  const dir = fixture(t);
  assert.equal(authz(dir, ["issue", "WO-09-H", "--paths", "tools/", "--minutes", "60"]).status, 0);
  assert.equal(authz(dir, ["check", "WO-09-H", "--op", "check"]).status, 0, "granted while the sentinel is absent");
  mkdirSync(path.join(dir, path.dirname(HALT_SENTINEL)), { recursive: true });
  writeFileSync(path.join(dir, HALT_SENTINEL), "owner halt 2026-11-20 — drills stop\n");
  const chk = authz(dir, ["check", "WO-09-H", "--op", "check"]);
  assert.equal(chk.status, EXIT.DENIED, "HALT must exit 2 — " + chk.stdout);
  assert.match(chk.stdout, /reason=HALTED/);
  assert.match(ledgerFor(dir, "WO-09-H").at(-1), /\|DENY\|WO-09-H\|stage=check\|reason=HALTED\|detail=odai\/dev_docs\/HALT present/);
  assert.equal(authz(dir, ["issue", "WO-09-H2", "--paths", "tools/", "--minutes", "5"]).status, EXIT.DENIED, "no new lease while halted");
  assert.equal(authz(dir, ["status"]).status, 0, "status is a read and stays available");
  assert.equal(authz(dir, ["revoke", "WO-09-H", "halt_sentinel_engaged"]).status, 0, "emergency revoke must always work");
  rmSync(path.join(dir, HALT_SENTINEL));
  assert.equal(authz(dir, ["check", "WO-09-H", "--op", "check"]).status, EXIT.DENIED, "revoked stays revoked after the halt clears");
});

test("lease hygiene: unknown id ⇒ NO_LEASE; scope ⇒ PATH_NOT_ALLOWED; touch renews; corrupt store fails closed", (t) => {
  const dir = fixture(t);
  assert.equal(authz(dir, ["check", "WO-09-NONE", "--op", "check"]).status, EXIT.DENIED);
  assert.match(authz(dir, ["check", "WO-09-NONE", "--op", "check"]).stdout, /reason=NO_LEASE/);
  assert.equal(authz(dir, ["issue", "WO-09-S7", "--paths", "tools/,tests/", "--minutes", "60"]).status, 0);
  const off = authz(dir, ["check", "WO-09-S7", "--op", "check", "--path", "src/TalkView.tsx"]);
  assert.equal(off.status, EXIT.DENIED);
  assert.match(off.stdout, /reason=PATH_NOT_ALLOWED/);
  assert.equal(authz(dir, ["check", "WO-09-S7", "--op", "check", "--path", "tools/watchd.mjs"]).status, 0, "in-scope path grants");
  assert.equal(authz(dir, ["check", "WO-09-S7", "--op", "deploy"]).status, EXIT.DENIED, "op outside lease ops");
  const exp = fixture(t);
  assert.equal(authz(exp, ["issue", "WO-09-T", "--paths", "tools/", "--minutes", "0"]).status, 0);
  assert.equal(authz(exp, ["touch", "WO-09-T"]).status, EXIT.DENIED, "cannot touch an expired lease");
  assert.match(authz(exp, ["touch", "WO-09-T"]).stdout, /reason=EXPIRED/);
  writeFileSync(path.join(exp, LEASES_FILE), "{ not json");
  assert.equal(authz(exp, ["check", "WO-09-T", "--op", "check"]).status, EXIT.DENIED, "corrupt lease store fails closed");
  assert.match(authz(exp, ["check", "WO-09-T", "--op", "check"]).stdout, /reason=NO_LEASE/);
});

/* ======================================================================================
 * pure decision table + inertness + seal contract
 * ===================================================================================== */
test("evaluate()/pathAllowed decision table is pure and deterministic for every machine reason", () => {
  const L = (o) => ({ issued_at: "2026-11-20T00:00:00Z", expires_at: "2026-11-20T01:00:00Z", minutes: 60,
    paths: ["tools/"], ops: ["check", "commit"], budget: 12, single_use: false, used_by_op: {}, revoked: false, ...o });
  const now = Date.parse("2026-11-20T00:30:00Z");
  assert.equal(evaluate(L(), { op: "check", now, ownerToken: false }).granted, true);
  assert.equal(evaluate(L(), { op: "publish", now, ownerToken: false }).reason, "OP_NOT_ALLOWED");
  assert.equal(evaluate(L({ ops: ["check", "commit", "publish"] }), { op: "publish", now, ownerToken: true }).granted, true);
  assert.equal(evaluate(L({ revoked: true }), { op: "check", now }).reason, "REVOKED");
  assert.equal(evaluate(L({ expires_at: "2026-11-20T00:00:00Z" }), { op: "check", now }).reason, "EXPIRED");
  assert.equal(evaluate(L({ used_by_op: { check: 12 } }), { op: "check", now }).reason, "OVER_BUDGET");
  assert.equal(evaluate(L({ single_use: true, used_by_op: { check: 1 } }), { op: "check", now }).reason, "CONSUMED_RESUME");
  assert.equal(evaluate(L(), { op: "check", p: "server.mjs", now }).reason, "PATH_NOT_ALLOWED");
  assert.equal(evaluate(null, { op: "check", now }).reason, "NO_LEASE");
  assert.deepEqual([...DENIAL_REASONS].sort(), ["CONSUMED_RESUME", "EXPIRED", "HALTED", "INTEGRITY_FAILED", "NO_LEASE", "OP_NOT_ALLOWED", "OVER_BUDGET", "PATH_NOT_ALLOWED", "REVOKED"]);
  assert.equal(pathAllowed(L({ paths: ["*"] }), "anything/at/all"), true);
  for (const bad of ["/etc/passwd", "../escape", "", "tools/../server.mjs"]) assert.equal(pathAllowed(L(), bad), false, bad);
  assert.equal(ledgerLine("REVOKE", "WO-X", { reason: "pipe|injected" }).trim(), new Date().toISOString().replace(/\.\d+Z$/, "Z") + "|REVOKE|WO-X|reason=pipe;injected");
});

test("seal contract: compare() fails closed on tamper, unreadable file, blank manifest, unparsable text, stale row", () => {
  const bodies = new Map(PROTECTED_FILES.map((f, i) => [f, "body-" + i]));
  const read = (f) => { if (!bodies.has(f)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return Buffer.from(bodies.get(f)); };
  const seal = () => "# WO-09A header\n" + [...PROTECTED_FILES].sort().map((f) => sha256(read(f)) + "  " + f).join("\n") + "\n";
  assert.equal(compare(seal(), read).ok, true, JSON.stringify(compare(seal(), read).problems));
  const current = seal();
  bodies.set("tools/authz.mjs", "tampered");
  assert.match(compare(current, read).problems.join("|"), /MISMATCH tools\/authz\.mjs sealed=.*actual=/);
  assert.equal(compare(null, read).ok, false, "missing manifest is a FAIL, never a pass");
  bodies.delete("tools/authz.mjs");
  assert.match(compare(current, read).problems.join("|"), /UNREADABLE tools\/authz\.mjs \(ENOENT\)/);
  bodies.set("tools/authz.mjs", "body-0");
  assert.match(compare("# WO-09A header\n", read).problems.join("|"), /NOT_SEALED tools\/authz\.mjs/, "a protected file absent from the seal fails closed");
  assert.match(compare("this is not a manifest\n", read).problems.join("|"), /unparsable/, "unreadable structure fails closed");
  const stale = compare("# h\n" + "0".repeat(64) + "  tools/gone.mjs\n" + [...PROTECTED_FILES].sort().map((f) => sha256(read(f)) + "  " + f).join("\n"), read);
  assert.match(stale.problems.join("|"), /STALE_ROW tools\/gone\.mjs/);
});

test("inertness + scope: WO-09A tools import only node builtins; no runtime file imports them", () => {
  for (const f of [AUTHZ_REL, WATCHDOG_REL, "tools/guardrails_preflight.mjs", "tools/guardrail_harness.mjs"]) {
    const src = readFileSync(path.join(repoRoot, f), "utf8");
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g))
      assert.match(m[1], /^node:/, f + " must only import node builtins, found " + m[1]);
  }
  for (const f of [AUTHZ_REL, WATCHDOG_REL]) assert.ok(PROTECTED_FILES.includes(f), f + " must be inside the seal");
  assert.equal(PROTECTED_FILES.length, 5, "seal covers 5 executable security files; tools/SECURITY-FILES.sha256 itself is the 6th guarded artefact");
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(path.join(repoRoot, "server"));
  walk(path.join(repoRoot, "src"));
  files.push(path.join(repoRoot, "server.mjs"));
  for (const f of files)
    assert.doesNotMatch(readFileSync(f, "utf8"), /tools\/authz|verify_integrity/, "runtime file imports a WO-09A enforcement module: " + path.relative(repoRoot, f));
});

test("live ledger stays clean for this suite and the repo seal verifies at every step", (t) => {
  const dir = fixture(t);
  assert.equal(watchdog(dir).status, 0);
  const w = spawnSync(process.execPath, [path.join(repoRoot, WATCHDOG_REL), "check"], { encoding: "utf8" });
  assert.equal(w.status, 0, "repo seal must be current: " + w.stdout + w.stderr);
  const before = existsSync(path.join(repoRoot, LEDGER_FILE)) ? readFileSync(path.join(repoRoot, LEDGER_FILE), "utf8") : "";
  assert.equal(authz(dir, ["issue", "WO-09-L", "--paths", "tools/", "--minutes", "60"]).status, 0);
  assert.equal(authz(dir, ["check", "WO-09-L", "--op", "commit", "--path", "tools/watchd.mjs"]).status, EXIT.DENIED);
  const after = existsSync(path.join(repoRoot, LEDGER_FILE)) ? readFileSync(path.join(repoRoot, LEDGER_FILE), "utf8") : "";
  assert.equal(after, before, "fixture drills never write the live audit log");
});
