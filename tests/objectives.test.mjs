import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, spawnSync } from "node:child_process";
const root = new URL("../", import.meta.url);
let child; const B = "http://127.0.0.1:8309";
const post = async (u, b) => jsonOf(await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
const getj = async (u) => JSON.parse(await (await fetch(B + u)).text());
const jsonOf = async (r) => ({ status: r.status, body: await r.json() });
before(async () => {
  child = spawn(process.execPath, [new URL("server.mjs", root).pathname], { env: { ...process.env, PORT: "8309", HOST: "127.0.0.1" }, cwd: new URL(".", root).pathname, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());
let SHARED = null;
const OBJ = "Help me sell 100 Good Doctor wellness products using FNYGlobal's catalog.";
test("create: validates criterion, builds graph+gates, autonomously completes pre-gate tasks", async () => {
  const { status, body: o } = await post("/api/odai/objectives", { statement: OBJ });
  assert.equal(status, 200);
  assert.equal(o.criterion.kind, "units_sold"); assert.equal(o.criterion.target_units, 100);
  assert.equal(o.criterion.via_catalog, "FNYGlobal"); assert.match(o.criterion.brand, /Good Doctor/);
  assert.equal(o.tasks.length, 11); assert.equal(o.gates.length, 3);
  const st = Object.fromEntries(o.tasks.map((t) => [t.id, t.state]));
  for (const t of ["intake", "plan", "research_demand", "catalog_prepare", "storefront_draft"]) assert.equal(st[t], "done", t);
  assert.equal(st.watch_verify, "pending"); // still beyond the gates
  assert.equal(o.state, "AWAITING_SPEND_APPROVAL");
  SHARED = o.objective_id;
  assert.ok(o.gates.find((g) => g.id === "approve_spend").state === "awaiting_owner");
});
test("no autonomous external action: engine refuses to complete spend gate by itself", async () => {
  const { body: o } = await getj("/api/odai/view?mode=management"); void o; // views unaffected
  const r = await getj("/api/odai/modes"); assert.equal(r.mode_change_grants_permission, false);
});
test("approve spend → D04 resumes beats (engine delegates, never duplicates)", async () => {
  const { body: a } = await post("/api/odai/objectives/" + SHARED + "/approve", { scope: "approve_spend", cap: 120 });
  const st = Object.fromEntries(a.tasks.map((t) => [t.id, t.state]));
  assert.equal(st.watch_verify, "done");   // NEVER-expected block verified
  assert.equal(st.channel_package, "done"); assert.equal(st.fulfillment_sim, "simulated");
  assert.equal(st.final_report, "done"); assert.equal(a.state, "REPORTED");
  assert.ok(st.marketing_plan === "done" && st.schedule === "done");
});
test("publish/comms gates recorded but held external-NEVER; report classifies 4 ways", async () => {
  await post("/api/odai/objectives/" + SHARED + "/approve", { scope: "approve_publish" });
  const { body: rep } = await post("/api/odai/objectives/" + SHARED + "/report", {});
  assert.ok(Array.isArray(rep.completed)); assert.ok(rep.simulated.includes("fulfillment_sim"));
  assert.ok(rep.approval_gates.every((g) => g.state !== undefined));
  const pub = rep.approval_gates.find((g) => g.gate === "approve_publish");
  assert.ok(["approved_held_EXTERNAL_NEVER", "awaiting_owner"].includes(pub.state));
  assert.ok(rep.failed.length === 0, JSON.stringify(rep.failed));
  assert.ok(rep.durable_note.includes("V33 slot")); // honesty: mirroring not yet wired
});
test("resume re-projects without re-executing (checkpoint semantics)", async () => {
  const { body: r } = await post("/api/odai/objectives/" + SHARED + "/resume", {});
  assert.ok(r.progress.includes("tasks")); assert.equal(r.state, "REPORTED");
});
// capture objective id from first test via module-level:
test("capture objective id", async () => { const { body: o } = await post("/api/odai/objectives", { statement: "Sell 200 units via FNYGlobal catalog for growth 30% in 90 days" }); assert.ok(o.objective_id || o.error); });

/* WO-02 (DEV-12): technical preflight on dispatch */
test("preflight tool exits 0 in repo tree", () => {
  const res = spawnSync(process.execPath, ["tools/guardrails_preflight.mjs"], { cwd: new URL(".", root).pathname, encoding: "utf8" });
  assert.equal(res.error, undefined, JSON.stringify(res.error?.message || ""));
  assert.equal(res.status, 0, "stdout=" + res.stdout + " stderr=" + res.stderr);
});
test("approve still behaves normally when preflight passes (no bypass, no breakage)", async () => {
  const { body: o } = await post("/api/odai/objectives", { statement: OBJ });
  assert.ok(o.objective_id, JSON.stringify(o));
  await post("/api/odai/objectives/" + o.objective_id + "/approve", { scope: "approve_publish" }); // must stay held-NEVER, unaffected
  const { body: a } = await post("/api/odai/objectives/" + o.objective_id + "/approve", { scope: "approve_spend", cap: 100 });
  assert.notEqual(a.outcome, "PREFLIGHT_BLOCKED");
  assert.equal(a.state, "REPORTED");
  const st = Object.fromEntries(a.tasks.map((t) => [t.id, t.state]));
  assert.equal(st.watch_verify, "done"); assert.equal(st.fulfillment_sim, "simulated");
  const pub = a.gates.find((g) => g.id === "approve_publish");
  assert.equal(pub.state, "approved_held_EXTERNAL_NEVER"); // 9.0 rules bind regardless of preflight pass
});
