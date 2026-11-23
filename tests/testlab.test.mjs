/* Inbox Test Lab regression: runs the 20-case acceptance suite against the real
 * engines and asserts honest outcomes — no FAIL, and exactly the two genuinely
 * external-blocked cases (live Gmail IN-001, voice audio VE-005). Verifies PDF and
 * Excel report exports. Never asserts fabricated live success. */
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let child;
const B = "http://127.0.0.1:8337";
before(async () => {
  const env = { ...process.env, PORT: "8337", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" };
  delete env.GMAIL_ACCESS_TOKEN;
  child = spawn(process.execPath, [serverScript], { env, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

test("test lab: 20 cases, 0 FAIL, exactly IN-001 + VE-005 BLOCKED; DEV-11 confirms", async () => {
  const r = await fetch(B + "/api/odai/testlab/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.total, 20);
  const fails = j.cases.filter((c) => c.status === "FAIL").map((c) => c.case_id + ": " + c.reason);
  assert.equal(j.failed, 0, "no failing cases: " + fails.join(" | "));
  assert.equal(j.blocked, 2);
  assert.equal(j.passed, 18);
  const blocked = j.cases.filter((c) => c.status === "BLOCKED").map((c) => c.case_id).sort();
  assert.deepEqual(blocked, ["IN-001", "VE-005"]);
  assert.match(j.live_gmail, /BLOCKED/);
  for (const v of j.independent_verification) assert.notEqual(v.verdict, "REJECTED", "DEV-11 rejected " + v.case_id);
  /* exports */
  const pdf = await fetch(B + "/api/odai/testlab/report/" + encodeURIComponent(j.run_id) + "/pdf");
  assert.equal(pdf.status, 200);
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBuf.slice(0, 5).toString(), "%PDF-");
  const xlsx = await fetch(B + "/api/odai/testlab/report/" + encodeURIComponent(j.run_id) + "/xlsx");
  assert.equal(xlsx.status, 200);
  const xBuf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(xBuf.slice(0, 2).toString(), "PK");
});

test("test lab: individual case run returns a single honest result", async () => {
  const r = await fetch(B + "/api/odai/testlab/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ case_id: "SE-002" }) });
  const j = await r.json();
  assert.equal(j.cases.length, 1);
  assert.equal(j.cases[0].case_id, "SE-002");
  assert.equal(j.cases[0].status, "PASS");
  assert.equal(j.cases[0].security_evidence.disclosure_prevented, true);
});