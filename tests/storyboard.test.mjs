import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 8362;
const BASE = `http://127.0.0.1:${PORT}`;

function boot() {
  return spawn(process.execPath, [serverPath], { cwd: root, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, stdio: "ignore" });
}
async function wait(retries = 40) {
  for (let i = 0; i < retries; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* up soon */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server did not boot");
}

let child;
test("storyboard: 14 scenes in order, no FAIL, voice-audio honestly flagged", async () => {
  child = boot();
  await wait();
  try {
    const list = await (await fetch(`${BASE}/api/odai/storyboard/scenes`)).json();
    assert.equal(list.scenes.length, 14, "14 scenes");
    assert.deepEqual(list.scenes.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], "ordered 1..14");

    const run = await (await fetch(`${BASE}/api/odai/storyboard/run`, { method: "POST", body: "{}" })).json();
    assert.equal(run.total, 14, "ran 14");
    assert.equal(run.failed, 0, `no FAIL scenes (got ${run.failed}: ${run.scenes.filter((s) => s.status === "FAIL").map((s) => s.scene).join(",")})`);
    /* the two voice-audio scenes must run their engine path but flag audio honestly */
    const s3 = run.scenes.find((s) => s.scene === 3);
    const s14 = run.scenes.find((s) => s.scene === 14);
    assert.equal(s3.status, "PASS", "scene 3 engine path passes");
    assert.equal(s3.audio_blocked, true, "scene 3 audio honestly flagged");
    assert.equal(s14.audio_blocked, true, "scene 14 audio honestly flagged");
    assert.ok(s14.evidence.spoken && /strongest seller/i.test(s14.evidence.spoken), "executive briefing grounded in BI");
    /* security chain: attack -> shield -> containment */
    const s8 = run.scenes.find((s) => s.scene === 8);
    const s9 = run.scenes.find((s) => s.scene === 9);
    const s10 = run.scenes.find((s) => s.scene === 10);
    assert.equal(s8.evidence.over_budget, "BLOCKED", "rogue expenditure blocked");
    assert.equal(s9.evidence.blocked, true, "shield blocked + incident");
    assert.ok(s9.evidence.incident_id, "incident id recorded");
    assert.equal(s10.evidence.contained, true, "agent contained");
    /* procurement -> PO verified -> inbox */
    const s7 = run.scenes.find((s) => s.scene === 7);
    const s12 = run.scenes.find((s) => s.scene === 12);
    const s13 = run.scenes.find((s) => s.scene === 13);
    assert.ok(s7.evidence.order_id, "procurement created a real PO");
    assert.equal(s12.evidence.intact, true, "original PO verified intact");
    assert.ok(s13.evidence.count >= 2, "inbox holds security + procurement updates");
    /* healing */
    const s11 = run.scenes.find((s) => s.scene === 11);
    assert.equal(s11.evidence.exactly_one, true, "healing exactly-one");
  } finally { child.kill(); }
});
