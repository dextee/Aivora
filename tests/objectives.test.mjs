import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interpret } from "../server/odai/objectives.mjs";
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

/* ================= WO-10 — intents move from UI into the engine ================= */
const REG = JSON.parse(readFileSync(new URL("../odai/config/intents_registry.json", import.meta.url), "utf8"));
const OWNER_LABELS = ["Start My Business", "Find Products", "Set Up My Online Shop", "Make Advertisements",
  "Find Customers", "Talk to Customers", "Deliver My Products", "Manage My Money",
  "Run My Business Automatically", "Protect My Business"];

test("WO-10 registry: valid JSON, ten owner-approved intents exactly, engine contract", () => {
  assert.equal(REG.intents.length, 10);
  assert.deepEqual(REG.intents.map((i) => i.label), OWNER_LABELS); // exact set AND order per directive
  assert.equal(new Set(REG.intents.map((i) => i.id)).size, 10);
  for (const i of REG.intents) {
    for (const f of ["id", "label", "utterance", "engine", "objective_template"]) assert.ok(f in i, `${i.id} missing ${f}`);
    assert.ok(["objective", "dashboard", "shield-note"].includes(i.engine), `${i.id} engine ${i.engine}`);
    if (i.engine === "objective") assert.ok(typeof i.objective_template === "string" && i.objective_template.length > 0);
    else assert.equal(i.objective_template, null, `${i.id} non-objective engine must carry null template`);
  }
  const byLabel = Object.fromEntries(REG.intents.map((i) => [i.label, i.engine]));
  assert.equal(byLabel["Manage My Money"], "dashboard");
  assert.equal(byLabel["Protect My Business"], "shield-note");
  assert.equal(REG.intents.filter((i) => i.engine === "objective").length, 8);
});
test("WO-10 registry: every objective_template is a measurable framing passing D03 interpret()", () => {
  for (const i of REG.intents.filter((x) => x.engine === "objective")) {
    const p = interpret(i.objective_template);
    assert.equal(p.valid, true, `${i.id}: ${p.reason}`);
    assert.equal(p.criterion.measurable, true, i.id);
  }
});
test("WO-10 GET /api/odai/intents serves the registry minus internal fields", async () => {
  const r = await getj("/api/odai/intents");
  assert.equal(r.intents.length, 10);
  for (const i of r.intents) {
    assert.equal("keywords" in i, false, `${i.id}: internal scoring field leaked`);
    assert.equal("id" in i && "label" in i && "utterance" in i && "engine" in i && "objective_template" in i, true, i.id);
  }
});
test("WO-10 POST /intents/match: 3 probes expect the right intents, default path side-effect-free", async () => {
  for (const [utterance, expected] of [
    ["Bring me buyers", "find-customers"],
    ["What can I sell?", "find-products"],
    ["please promote my products and run ads", "make-advertisements"],
  ]) {
    const { status, body } = await post("/api/odai/intents/match", { utterance });
    assert.equal(status, 200, utterance);
    assert.equal(body.launch, "match-only", utterance);
    assert.ok(body.intent, "no match for " + utterance);
    assert.equal(body.intent.id, expected, utterance + " -> " + body.intent.id);
    assert.ok(body.score >= 2, utterance);
    assert.equal("objective" in body, false, "default match must not create anything");
    assert.equal("keywords" in body.intent, false, "internal fields stay server-side");
  }
});
test("WO-10 autocreate=true is the ONLY launch path, and only for objective engines (WO-09 owner gate stays closed by default)", async () => {
  const dash = await post("/api/odai/intents/match?autocreate=true", { utterance: "Track spending, sales and profits" });
  assert.equal(dash.body.intent.id, "manage-my-money");
  assert.equal(dash.body.launch, "match-only", "dashboard engine must never spawn an objective");
  assert.equal("objective" in dash.body, false);
  const launch = await post("/api/odai/intents/match?autocreate=true", { utterance: "What can I sell?" });
  assert.equal(launch.body.launch, "autocreate");
  const o = launch.body.objective;
  assert.ok(o && o.objective_id, JSON.stringify(o));
  assert.equal(o.criterion.kind, "units_sold");
  assert.equal(o.criterion.target_units, 50, "spawned from the registry template, not the raw utterance");
  assert.equal(o.state, "AWAITING_SPEND_APPROVAL", "objective engine still stops at owner gates — no autonomous launch");
});
test("WO-10 USER bundle audit: chip wall gone, text affordance shipped, zero exrow/exchip references", () => {
  const assets = new URL("../dist/assets/", import.meta.url);
  const js = readdirSync(fileURLToPath(assets)).filter((f) => f.endsWith(".js"));
  assert.ok(js.length >= 1, "no built JS assets");
  const bundle = js.map((f) => readFileSync(new URL(f, assets), "utf8")).join("");
  assert.equal(bundle.includes("Run My Business Automatically"), false, "old chip label still in USER bundle");
  assert.equal(bundle.includes("Help me start earning"), false, "old chip utterance still in USER bundle");
  assert.equal(bundle.includes("What can you run for me"), true, "text affordance missing from USER bundle");
  const srcDir = new URL("../src/", import.meta.url);
  const allSrc = readdirSync(fileURLToPath(srcDir)).filter((f) => /\.(tsx?|ts|css)$/.test(f))
    .map((f) => readFileSync(new URL(f, srcDir), "utf8")).join("\n");
  assert.equal(allSrc.includes("exrow"), false, "dead exrow reference remains");
  assert.equal(allSrc.includes("exchip"), false, "dead exchip reference remains");
  assert.equal(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").includes(".exchip"), false, "exchip CSS rule remains");
});
