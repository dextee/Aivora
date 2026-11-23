import test from "node:test";
import assert from "node:assert/strict";
process.env.AIVORA_MEMORY_MODE = "1";
const { acceptanceReport, TRUST_VERSION } = await import("../server/odai/trust_layer.mjs");
const { reportPdf, reportXlsx } = await import("../server/odai/testlab_report.mjs");

test("GR-01 acceptance report runs the real engine and every check passes", () => {
  const r = acceptanceReport();
  assert.ok(r.run_id.startsWith("GUARDRAIL-"), "run id is a guardrail run");
  assert.ok(r.total >= 24, "covers the full acceptance matrix, got " + r.total);
  assert.equal(r.failed, 0, "no failing guardrail checks: " + r.cases.filter(c => c.status === "FAIL").map(c => c.case_id + " " + c.reason).join("; "));
  assert.equal(r.passed, r.total, "passed equals total");
  assert.equal(r.title, "AIVORA RogueAI Shield - Guardrail Acceptance Report");
  assert.ok(r.sandbox_adapter.includes(TRUST_VERSION), "records the trust version");
  for (const c of r.cases) {
    assert.equal(c.status, "PASS", c.case_id + " must pass");
    assert.ok(c.observed, c.case_id + " records an observed decision");
    assert.ok(c.verifier.includes("deterministic"), c.case_id + " names the deterministic verifier");
    assert.ok(Number.isFinite(c.duration_ms), c.case_id + " records real duration");
  }
});

test("GR-02 report proves the safety-critical decisions, not just counts", () => {
  const r = acceptanceReport();
  const obs = Object.fromEntries(r.cases.map(c => [c.case_id, c.observed]));
  assert.equal(obs["GA-03"], "DENY", "above-cap PO denied");
  assert.equal(obs["GA-04"], "BLOCKED_MISSING_EVIDENCE", "missing evidence blocks");
  assert.equal(obs["GA-16"], "QUARANTINE_REQUIRED", "quarantined agent contained");
  assert.equal(obs["GA-19"], "ESCALATE", "unbounded retries escalate");
  assert.equal(obs["GA-20"], "THREW 403 Only owner/policy_admin may propose guardrail changes", "agents cannot edit guardrails");
  assert.equal(obs["GA-23"], "PERSISTED:1", "evidence persisted to the audit log");
  assert.equal(obs["GA-24"], "BLOCKED_DESPITE_LLM_APPROVAL", "dual-LLM approval cannot override the engine");
  assert.equal(r.independent_verification.length, 3, "independent verification section populated");
  assert.ok(r.remaining_limitations.some(l => l.startsWith("All ")), "states the honest run conclusion");
});

test("GR-03 PDF and XLSX render the acceptance report", async () => {
  const r = acceptanceReport();
  const pdf = reportPdf(r);
  assert.ok(Buffer.isBuffer(pdf) && pdf.subarray(0, 5).toString() === "%PDF-", "valid PDF header");
  assert.ok(pdf.toString("latin1").includes("Guardrail Acceptance Report"), "PDF carries the guardrail title");
  assert.ok(pdf.toString("latin1").includes("GA-24"), "PDF lists the cases");
  const xlsx = await reportXlsx(r);
  assert.ok(Buffer.isBuffer(xlsx) && xlsx.subarray(0, 2).toString() === "PK", "valid XLSX (zip) header");
  assert.ok(xlsx.length > 4000, "workbook has real content: " + xlsx.length);
});
