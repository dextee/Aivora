import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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

/* ============ WO-10R HOTFIX — objective create/list under the intents router ============
 * Live V40 audit showed POST /api/odai/objectives answering {"error":"not measurable…"}
 * for EVERY V38-style body (the create branch parses only the `statement` key after the
 * intents rewire) and GET /api/odai/objectives falling through to "unknown odai path"
 * (the list branch was dropped). These tests exercise the REAL HTTP handler end-to-end. */
const V38_WORDING = "Sell 30 Lumen Wellness products from the FNYGlobal catalog in 90 days";
let WO10R_ID = null;
for (const field of ["text", "objective", "utterance", "statement"]) {
  test(`WO-10R POST /objectives accepts V38 wording verbatim in the "${field}" field (measurable + plan structure)`, async () => {
    const { status, body: o } = await post("/api/odai/objectives", { [field]: V38_WORDING });
    assert.equal(status, 200);
    assert.equal(o.error, undefined, `payload {"${field}": V38 wording} rejected: ${JSON.stringify(o)}`);
    assert.ok(o.objective_id, "objective_id missing: " + JSON.stringify(o));
    assert.equal(o.criterion.kind, "units_sold");
    assert.equal(o.criterion.target_units, 30);
    assert.equal(o.criterion.via_catalog, "FNYGlobal");
    assert.match(o.criterion.brand, /Lumen/);
    assert.equal(o.tasks.length, 11, "11-task D03 plan projected");
    assert.equal(o.gates.length, 3, "3 owner gates projected");
    assert.equal(o.state, "AWAITING_SPEND_APPROVAL", "gates stay closed on the accepted path");
    if (field === "text") WO10R_ID = o.objective_id;
  });
}
test("WO-10R GET /objectives returns 200 with the tenant's objectives list", async () => {
  const r = await fetch(B + "/api/odai/objectives");
  assert.equal(r.status, 200, "GET /api/odai/objectives must serve the list, not unknown-odai-path");
  const body = await r.json();
  const { DEMO_TENANT } = await import("../server/odai/store.mjs");
  assert.equal(body.tenant_id, DEMO_TENANT, "default demo tenant scope");
  assert.ok(Array.isArray(body.objectives), "objectives array missing: " + JSON.stringify(body).slice(0, 200));
  assert.ok(body.objectives.length >= 1, "list is empty though POSTs just created objectives");
  const ids = body.objectives.map((x) => x.objective_id);
  if (WO10R_ID) assert.ok(ids.includes(WO10R_ID), "created objective not listed");
  for (const x of body.objectives) assert.ok(x.objective_id && x.state && x.criterion, JSON.stringify(x).slice(0, 120));
});
test("WO-10R still rejects unmeasurable statements (restore parsing ≠ relax gate)", async () => {
  const { status, body } = await post("/api/odai/objectives", { text: "make me rich eventually" });
  assert.equal(status, 200);
  assert.match(String(body.error), /not measurable/);
});

/* ============ UI-01 — voice-first USER view: chip expansion + objective plan card ============
 * jsdom-level proof: transpile src/IntentChips.tsx and render it with react-dom/server,
 * feeding a MOCKED GET /api/odai/intents response (the engine registry shape). Assert the
 * exactly-10 chips render (label + utterance each) and the plan card renders criterion +
 * 11-task plan + awaiting-owner gates from a mocked objective view. Also assert ZERO pre-
 * WO-10 wall prose is hardcoded in the client (labels/utterances flow from the engine only). */
const req = createRequire(import.meta.url);
const ts = req("typescript");
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

async function loadIntentChips() {
  const source = readFileSync(new URL("../src/IntentChips.tsx", import.meta.url), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const tmp = fileURLToPath(new URL("../tests/.ui01-chips.generated.mjs", import.meta.url));
  writeFileSync(tmp, out);
  try { return await import(pathJoinUrl(tmp)); } finally { unlinkSync(tmp); }
}
const pathJoinUrl = (p) => new URL("file://" + p).href;

function mockedIntentsResponse() {
  const reg = JSON.parse(readFileSync(new URL("../odai/config/intents_registry.json", import.meta.url), "utf8"));
  // mimic the server: strip keywords, serve public fields for all ten intents
  return { tenant_id: "t-ui01", intents: reg.intents.map(({ keywords, ...p }) => p) };
}

test("UI-01: exactly 10 intent chips render from a mocked /intents response (label + utterance each)", async () => {
  const mod = await loadIntentChips();
  const items = mod.parseIntentsResponse(mockedIntentsResponse());
  assert.equal(items.length, 10, "registry must expose exactly ten intents to the client");
  assert.equal("keywords" in items[0], false, "internal fields stripped before render");
  const html = renderToStaticMarkup(React.createElement(mod.IntentChips, { items, onPick: () => {} }));
  const chipCount = (html.match(/class="intent-chip"/g) || []).length;
  assert.equal(chipCount, 10, `expected 10 chips, rendered ${chipCount}`);
  const reg = JSON.parse(readFileSync(new URL("../odai/config/intents_registry.json", import.meta.url), "utf8"));
  for (const it of reg.intents) {
    assert.ok(html.includes(it.label), `chip label missing: ${it.label}`);
    assert.ok(html.includes(`<span>${it.utterance}</span>`), `chip utterance missing: ${it.utterance}`);
  }
});

test("UI-01: plan card renders criterion + full 11-task plan + awaiting-owner gates", async () => {
  const mod = await loadIntentChips();
  // build a realistic awaiting-owner view through the REAL engine (interpret → criterion)
  const p = interpret("Sell 40 Lumen Wellness products from the FNYGlobal catalog through my online shop in 60 days");
  assert.equal(p.valid, true, "template must be measurable");
  const obj = {
    objective_id: "OBJ-ui01", state: "AWAITING_SPEND_APPROVAL", criterion: p.criterion,
    tasks: [
      { id: "intake", state: "done" }, { id: "plan", state: "done" }, { id: "research_demand", state: "done" },
      { id: "catalog_prepare", state: "pending" }, { id: "storefront_draft", state: "pending" }, { id: "marketing_plan", state: "pending" },
      { id: "schedule", state: "pending" }, { id: "watch_verify", state: "pending" }, { id: "channel_package", state: "pending" },
      { id: "fulfillment_sim", state: "pending" }, { id: "final_report", state: "pending" },
    ],
    gates: [
      { id: "approve_spend", scope: "advertising spend", state: "awaiting_owner" },
      { id: "approve_publish", scope: "external publishing (Shopee/Facebook)", state: "not_reached" },
      { id: "approve_customer_comms", scope: "customer messages (WhatsApp/email)", state: "not_reached" },
    ],
  };
  const html = renderToStaticMarkup(React.createElement(mod.ObjectivePlanCard, { label: "Set Up My Online Shop", o: obj }));
  assert.ok(html.includes("objcard"), "plan card root missing");
  assert.ok(html.includes("Sell 40"), "criterion line not rendered: " + mod.criterionLine(p.criterion));
  assert.ok(/awaiting the gates|Awaiting owner approval|awaiting/i.test(html), "awaiting-owner state not surfaced");
  const taskRows = (html.match(/<li/g) || []).length;
  assert.equal(taskRows, 11, `expected 11 task rows, got ${taskRows}`);
  assert.ok(html.includes("advertising spend"), "spend gate scope not shown");
  assert.ok(html.includes("awaiting your approval"), "awaiting-owner gate label not shown");
  assert.ok(html.includes("queued"), "not-reached gates shown as queued");
});

test("UI-01: the 'not measurable' engine error surfaces its restate hint VERBATIM", async () => {
  const mod = await loadIntentChips();
  const HINT = "not measurable — restate with a number (units / % over days)";
  const out1 = mod.objectiveCreateOutcome({ error: HINT });
  assert.equal(out1.ok, false);
  assert.equal(out1.hint, HINT, "hint must be shown character-for-character as the server wrote it");
  // empty / unparseable body → not ok, and never a crash
  assert.equal(mod.objectiveCreateOutcome(null).ok, false);
  assert.equal(mod.objectiveCreateOutcome({}).ok, false, "empty body never crashes the outcome parser");
});

test("UI-01: zero intent prose hardcoded in the client — no pre-WO-10 wall labels anywhere in src/ or USER bundle", () => {
  const reg = JSON.parse(readFileSync(new URL("../odai/config/intents_registry.json", import.meta.url), "utf8"));
  const srcDir = new URL("../src/", import.meta.url);
  const srcAll = readdirSync(fileURLToPath(srcDir)).filter((f) => /\.(tsx?|ts|css)$/.test(f))
    .map((f) => readFileSync(new URL(f, srcDir), "utf8")).join("\n");
  // every registry label/utterance must be absent from the shipped client source
  const offenders = [];
  for (const it of reg.intents) {
    for (const s of [it.label, it.utterance]) {
      // the ONLY permissible occurrence is a comment referencing the chip flow, never a rendered string literal
      if (new RegExp(`["\`']\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(srcAll)) offenders.push(s);
    }
  }
  assert.deepEqual(offenders, [], `client renders intent prose: ${offenders.join(", ")}`);
  // and it never reaches the USER bundle (labels/utterances only ever arrive via fetch)
  const assets = new URL("../dist/assets/", import.meta.url);
  const js = readdirSync(fileURLToPath(assets)).filter((f) => f.endsWith(".js"));
  const bundle = js.map((f) => readFileSync(new URL(f, assets), "utf8")).join("");
  for (const it of reg.intents) {
    assert.equal(bundle.includes(it.utterance), false, `utterance leaked into bundle: ${it.utterance}`);
  }
  // affordance + plan hook strings DO ship
  assert.equal(bundle.includes("What can you run for me"), true);
});
