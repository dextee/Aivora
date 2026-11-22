import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 8361;
const BASE = `http://127.0.0.1:${PORT}`;

function boot() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, stdio: "ignore",
  });
  return child;
}
async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not boot");
}
const jget = async (p) => (await fetch(BASE + p)).json();
const jpost = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();

let child;
test("business test lab: 45 cases, zero FAIL, only genuine external BLOCKED", async () => {
  child = boot();
  await waitForServer();
  try {
    const cases = await jget("/api/odai/bizlab/cases");
    assert.equal(cases.cases.length, 45, "45 cases registered");
    const groups = new Set(cases.cases.map((c) => c.category));
    assert.equal(groups.size, 5, "five test groups");

    const rep = await jpost("/api/odai/bizlab/run", {});
    assert.equal(rep.total, 45, "ran 45");
    assert.equal(rep.failed, 0, `no FAIL cases (got ${rep.failed}: ${rep.cases.filter((c) => c.status === "FAIL").map((c) => c.case_id).join(",")})`);
    /* only the genuinely external-dependency cases may be BLOCKED */
    const allowedBlocked = new Set(["BI-009", "PO-005", "PO-008", "PH-004", "PH-009", "CL-004", "E2E-003"]);
    for (const b of rep.cases.filter((c) => c.status === "BLOCKED")) assert.ok(allowedBlocked.has(b.case_id), `unexpected BLOCKED ${b.case_id}`);
    assert.ok(rep.passed >= 38, `at least 38 PASS (got ${rep.passed})`);

    /* DEV-11 must reject nothing */
    const rejected = rep.independent_verification.filter((v) => v.verdict === "REJECTED");
    assert.equal(rejected.length, 0, "DEV-11 rejected nothing");

    /* key financial/dedup evidence present */
    const bi1 = rep.cases.find((c) => c.case_id === "BI-001");
    assert.ok(bi1.evidence.verified > 0, "BI-001 has verified records");
    assert.ok(Math.abs(bi1.evidence.window_revenue - bi1.evidence.dashboard_revenue) < 0.01, "revenue reconciled");
    const ph8 = rep.cases.find((c) => c.case_id === "PH-008");
    assert.equal(ph8.evidence.no_double_count, true, "no duplicate inventory movement");
    const e2e4 = rep.cases.find((c) => c.case_id === "E2E-004");
    assert.equal(e2e4.evidence.no_double_count, true, "E2E-004 no double count");

    /* report retrieval + PDF/XLSX */
    const got = await jget(`/api/odai/bizlab/report/${encodeURIComponent(rep.run_id)}`);
    assert.equal(got.run_id, rep.run_id, "report retrievable");
    const pdf = await fetch(`${BASE}/api/odai/bizlab/report/${encodeURIComponent(rep.run_id)}/pdf`);
    assert.equal(pdf.status, 200, "pdf 200");
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString(), "%PDF-", "valid PDF");
    const xls = await fetch(`${BASE}/api/odai/bizlab/report/${encodeURIComponent(rep.run_id)}/xlsx`);
    assert.equal(xls.status, 200, "xlsx 200");
    const xlsBuf = Buffer.from(await xls.arrayBuffer());
    assert.equal(xlsBuf.subarray(0, 2).toString(), "PK", "valid xlsx zip");
  } finally { child.kill(); }
});
