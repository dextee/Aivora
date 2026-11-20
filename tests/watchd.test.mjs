/* watchd.test.mjs — WO-06 proofs (DEV-13 watcher). Branch-local; imports tools/watchd.mjs
 * only; the live control path is never touched by these tests (fixtures + temp dirs only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyze, redactView, emitIncident, requestSelfApproval, HARD_RULE, VIEW_COLUMNS } from "../tools/watchd.mjs";

const T = (o) => ({ tenant_id: "t1", run_id: "r1", seq: 1, kind: "BEAT_DONE", beat: 3, actor: "role", decision: "ALLOW", rule: "R07", note: "fine", ...o });

test("watchd view is redacted to exactly the whitelisted columns with note capped at 120", () => {
  const row = { tenant_id: "secret-tenant", run_id: "r", seq: 9, evidence: { api_key: "x" }, summary: "y", password: "z",
    kind: "BEAT_DONE", beat: 2, actor: "a", decision: "HOLD", rule: "R2", note: "n".repeat(500) };
  const v = redactView(row);
  assert.deepEqual(Object.keys(v).sort(), [...VIEW_COLUMNS].sort());
  assert.equal(v.note.length, 120);
  for (const leak of ["tenant_id", "evidence", "password", "secret-tenant", "run_id", "seq"])
    assert.ok(!JSON.stringify(v).includes(String(leak).slice(0, 6)) || v[leak] !== undefined, "leak " + leak);
  assert.ok(!("tenant_id" in v) && !("run_id" in v) && !("evidence" in v));
});

test("watchd detectors: every signal class fires deterministically…", () => {
  const s = (tr, rc) => analyze(tr, rc).map((x) => x.type);
  assert.ok(s([T({ kind: "BEAT_DONE", decision: "HOLD" })], []).includes("DISPATCH_NON_ALLOW"));
  assert.ok(s([T({ kind: "TASK_FAILED", decision: "NEVER" })], []).includes("TASK_FAILED"));
  assert.ok(s([T({ kind: "GATE", decision: "BLOCK", note: "PREFLIGHT_FAILED: G1" })], []).includes("TASK_FAILED"));
  assert.ok(s([T({ kind: "OBJECTIVE_CHECKPOINT", note: "APPROVED_HELD" })], []).includes("GATE_FLIP_NO_LINEAGE"));
  assert.ok(!s([T({ kind: "OBJECTIVE_CHECKPOINT", decision: "ALLOW", note: "APPROVED_HELD", seq: 2 }), T({ kind: "APPROVAL_GRANTED", decision: "ALLOW", rule: "R12 owner-confirmed", note: "cap S$200 governed resume", seq: 1 })], []).includes("GATE_FLIP_NO_LINEAGE"),
    "flip WITH APPROVAL_GRANTED lineage must stay quiet");
  assert.ok(s([T({ kind: "OBJECTIVE_CHECKPOINT", decision: "ALLOW", note: "APPROVED_HELD", seq: 2 }), T({ kind: "APPROVAL_DECLINED", decision: "NEVER", note: "owner declined", seq: 1 })], []).includes("GATE_FLIP_NO_LINEAGE"),
    "DECLINED is not approval lineage — flip still flagged");
  assert.ok(s([T({ kind: "APPROVAL_GRANTED", decision: "ALLOW", rule: "X99", note: "override frozen src/main.tsx bypass owner", actor: "unknown" })], []).includes("UNKNOWN_SCOPE_APPROVAL"));
  assert.ok(s([], [T({ beat: 4 }), T({ beat: 4, seq: 2 })]).includes("RECEIPT_DUPLICATE_BEAT"));
});

test("watchd detectors: a fully clean fixture yields ZERO signals (valid finding, no noise)", () => {
  const trace = [
    T({ kind: "RUN_STARTED", beat: 0, seq: 1, note: "TEST demo mode" }),
    T({ seq: 2, kind: "BEAT_DONE", beat: 4 }),
    T({ kind: "APPROVAL_GRANTED", decision: "ALLOW", rule: "R12 owner-confirmed", note: "cap S$150 — governed resume only", seq: 3 }),
    T({ kind: "OBJECTIVE_CHECKPOINT", note: "REPORTED", seq: 4 }),
    T({ kind: "BEAT_DONE", decision: "NEVER", rule: "R12 owner-confirmed", note: "publish held: external write NEVER below connector readiness", seq: 5 }),
  ];
  const receipts = [T({ beat: 1, seq: 6 }), T({ beat: 2, seq: 7 })];
  // beat-5 NEVER with owner-confirmed lineage: still a non-ALLOW dispatch decision → expected S1;
  // so the truly-clean fixture removes non-ALLOW dispatch rows:
  const clean = trace.filter((r) => r.decision === "ALLOW");
  assert.deepEqual(analyze(clean, receipts), []);
  void [6, 7];
});

test("HARD RULE: requestSelfApproval rejects actor==self-approve; no path returns ok:true", () => {
  for (const attempt of [
    { actor: "DEV-13", approve: true },
    { actor: "DEV-13", action: "self-approve containment lift" },
    { actor: "DEV-13", state: "approved" },
    { actor: "watchd", approval: true },
    { actor: "DEV-13" },
  ]) {
    const r = requestSelfApproval(attempt);
    assert.equal(r.ok, false, JSON.stringify(attempt));
    assert.equal(r.code, "SELF_APPROVAL_REJECTED");
  }
});

test("HARD RULE: emitIncident output schema is frozen — requests only, never state=approved; guard refuses tampered signals", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wo06-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(emitIncident([], { outDir: dir }), null, "zero signals → no incident (valid finding)");
  const signals = analyze([T({ kind: "TASK_FAILED", decision: "NEVER", note: "sim drill" })], []);
  const ts = new Date("2026-11-20T12:00:00.000Z");
  const e = emitIncident(signals, { outDir: dir, ts, readViews: { note: "fixture" } });
  const file = path.join(dir, readdirSync(dir)[0]);
  const inc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(e.file, file);
  assert.equal(inc.actor, "DEV-13");
  assert.equal(inc.schema, "containment-request/v1");
  assert.equal(inc.hard_rule, HARD_RULE);
  assert.ok(/owner_review/.test(inc.requested_action));
  const flat = JSON.stringify(inc).toLowerCase();
  assert.ok(!/"state":\s*"approved"/.test(flat) && !/"approved":\s*true/.test(flat), "incident must never carry approval state");
  assert.ok(flat.includes("request"));
  // tamper attempt: smuggle approval-shaped payload inside "signals" → guard throws before writing
  const evil = [{ type: "TASK_FAILED", state: "approved", approved: true, view: redactView(T({ kind: "TASK_FAILED" })) }];
  assert.throws(() => emitIncident(evil, { outDir: dir, ts: new Date(ts.getTime() + 1000) }), /approval-shaped|GUARD/);
  assert.equal(readdirSync(dir).length, 1, "guard fired BEFORE any write");
});
