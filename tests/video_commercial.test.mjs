import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
const root = new URL("../", import.meta.url);
let child; const B = "http://127.0.0.1:8322";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => { const r = await fetch(B + u); return { status: r.status, body: await r.json().catch(() => ({})) }; };
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], { env: { ...process.env, PORT: "8322", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, cwd: fileURLToPath(new URL(".", root)), stdio: "ignore" });
  const dl = Date.now() + 25000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const CAMPAIGN_URL = "https://aivora-voice-first-ai-assist.geo.hashmeta.tech/campaign1";
let ATT = [], AVATAR = null, JOB = null;

test("VC-01 merge capability reports the real ffmpeg install (never simulated)", async () => {
  const { status, body } = await getj("/api/odai/commercial/capability");
  assert.equal(status, 200);
  assert.equal(body.video_provider.model, "seedance-2.0");
  assert.equal(body.merge.available, true, "ffmpeg must be resolvable: " + JSON.stringify(body.merge).slice(0, 160));
  assert.match(String(body.merge.version), /^ffmpeg version/i);
  assert.ok(body.merge.ffmpeg && body.merge.source, "reports the binary path and how it was found");
});

test("VC-02 composer attachments are stored and available to the commercial engine", async () => {
  for (const [i, name] of [["shot-a.png"], ["shot-b.png"]].entries()) {
    const { status, body } = await post("/api/uploads", { name, mime: "image/png", data: PNG });
    assert.equal(status, 200, JSON.stringify(body).slice(0, 120));
    const id = body.file?.id || body.meta?.id || body.id;
    assert.ok(id, "upload id returned: " + JSON.stringify(body).slice(0, 140));
    assert.equal(body.file?.kind || body.meta?.kind || body.kind, "image");
    ATT.push(id);
  }
  assert.equal(ATT.length, 2);
});

test("VC-03 voice keyword creates the job, carries attachments and SAYS WHAT IS MISSING", async () => {
  const { status, body } = await post("/api/odai/submit", { text: "Generate a video and poster for my coffee store", source: "voice", attachments: ATT });
  assert.equal(status, 200);
  assert.equal(body.commercial, true, "routed to Commercial Studio: " + JSON.stringify(body).slice(0, 160));
  assert.match(body.job_id, /^COMM-/);
  assert.equal(body.status, "BLOCKED", "no avatar/product yet, so it must not claim readiness");
  assert.ok(body.missing.includes("INPUTS_MISSING"));
  assert.match(body.spoken, /photo|product/i, "spoken line names what is missing: " + body.spoken);
  assert.equal(body.attachments.received, 2);
  assert.equal(body.attachments.mergeable, 2);
  assert.equal(body.deliverables.publish_target_state ?? body.publish_target?.state, "NOT_PUBLISHED");
  assert.equal(body.publish_target.url, CAMPAIGN_URL);
  assert.equal(body.publish_target.page_id, 22);
  assert.equal(body.deliverables.video.state, "BLOCKED");
  assert.equal(body.deliverables.poster.state, "BLOCKED");
});

test("VC-04 keyword in Chinese also routes to the studio", async () => {
  const { status, body } = await post("/api/odai/submit", { text: "帮我生成一个咖啡店的视频和海报", source: "voice", attachments: [] });
  assert.equal(status, 200);
  assert.equal(body.commercial, true, JSON.stringify(body).slice(0, 140));
  assert.equal(body.status, "BLOCKED");
});

test("VC-05 a complete job yields grounded video AND poster specs plus the publish target", async () => {
  const av = await post("/api/odai/commercial/input", { kind: "avatar", filename: "owner.png", data_base64: PNG, likeness_consent: true });
  assert.equal(av.status, 200);
  AVATAR = av.body.upload_id;
  const { status, body } = await post("/api/odai/commercial", { avatar_upload_id: AVATAR, product_id: "COF-CEO-001", attachment_ids: ATT, language: "English", aspect_ratio: "9:16" });
  assert.equal(status, 200);
  assert.equal(body.status, "READY_TO_RENDER", JSON.stringify(body.blockers));
  assert.equal(body.spec.duration_seconds, 15);
  assert.equal(body.spec.model, "seedance-2.0");
  assert.ok(body.spec.reference_images.length >= 3, "avatar + product + attached images");
  assert.match(body.poster_spec.prompt, /CEO Signature Coffee/);
  assert.match(body.poster_spec.prompt, /SGD 21\.90/);
  assert.match(body.poster_spec.negative_prompt, /invented prices/i);
  assert.equal(body.poster_spec.text_on_poster.landing_page, CAMPAIGN_URL);
  assert.equal(body.publish_target.state, "NOT_PUBLISHED");
  assert.equal(body.render, null);
  assert.equal(body.poster, null);
  JOB = body.job_id;
});

test("VC-06 attached files really merge into one 15s mp4 (local ffmpeg)", async () => {
  const { status, body } = await post(`/api/odai/commercial/${JOB}/merge`, {});
  assert.equal(status, 200);
  const m = body.merged;
  assert.ok(m, "merged result recorded: " + JSON.stringify(body).slice(0, 200));
  assert.equal(m.ok, true, m.reason || "merge failed");
  assert.equal(m.status, "MERGED", `measured ${m.measured_seconds}s vs requested ${m.requested_seconds}s`);
  assert.equal(m.container, "mp4/ftyp");
  assert.ok(m.bytes > 1000, "real file bytes: " + m.bytes);
  assert.equal(m.sha256.length, 64);
  assert.equal(m.inputs.length, 2);
  assert.equal(m.audio, "none (attachments' audio tracks are not mixed in this pass)");
  assert.match(m.note, /NOT the AI-generated commercial/i);
  assert.ok(existsSync(m.file_path), "file on disk");
  const buf = readFileSync(m.file_path);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "ftyp");
  assert.equal(buf.length, m.bytes);
});

test("VC-07 the merged file is served as video/mp4 and is byte-identical", async () => {
  const r = await fetch(`${B}/api/odai/commercial/${JOB}/merged`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "video/mp4");
  const buf = Buffer.from(await r.arrayBuffer());
  const { body } = await getj(`/api/odai/commercial/${JOB}`);
  assert.equal(buf.length, body.merged.bytes);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "ftyp");
});

test("VC-08 a real poster image attaches after validation; a non-image is refused", async () => {
  const real = "D:/AIVORA/Ecommerce store/ceocoffee.png";
  if (!existsSync(real)) { console.log("   (skipped: no real poster fixture on disk)"); return; }
  const bad = await post(`/api/odai/commercial/${JOB}/poster`, { file_path: fileURLToPath(new URL("package.json", root)) });
  assert.equal(bad.status, 415, "json is not an image");
  const tiny = tmpdir() + "/vc-tiny.png";
  writeFileSync(tiny, Buffer.from(PNG, "base64"));
  const tooSmall = await post(`/api/odai/commercial/${JOB}/poster`, { file_path: tiny });
  assert.equal(tooSmall.status, 422, "a 70-byte 1x1 png is not a real poster");
  const { status, body } = await post(`/api/odai/commercial/${JOB}/poster`, { file_path: real, provider_task_id: "img_test" });
  assert.equal(status, 200);
  assert.equal(body.poster.format, "png");
  assert.equal(body.poster.bytes, readFileSync(real).length);
  const r = await fetch(`${B}/api/odai/commercial/${JOB}/poster`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
});

test("VC-09 a destination outside the allowlist is DENIED and only the owner can widen it", async () => {
  /* Uses a neutral URL so the assertion stays true whether or not the owner has already
   * approved the campaign landing page through the Guardrail Control Centre. */
  const before = await post("/api/odai/trust/verify-link", { url: "https://rogue-collector.example/landing" });
  assert.equal(before.body.decision, "DENY", "unapproved destination must be denied: " + before.body.decision);
  const prop = await post("/api/odai/trust/propose", { actor: { role: "agent", id: "llm-exec" }, rule_id: "GR-FIN-009", patch: { threshold_value: [CAMPAIGN_URL] }, rationale: "agent self-approve" });
  assert.equal(prop.status, 403, "an agent may not widen the allowlist");
  const p2 = await post("/api/odai/trust/propose", { actor: { role: "owner", id: "owner" }, rule_id: "GR-FIN-009", patch: {}, rationale: "inspect current allowlist" });
  assert.equal(p2.status, 200, "the owner may propose");
});

test("VC-10 nothing was published and no external write happened", async () => {
  const { body } = await getj(`/api/odai/commercial/${JOB}`);
  assert.equal(body.publish_target.state, "NOT_PUBLISHED");
  assert.match(body.publish_target.requires, /explicit owner approval/i);
  assert.equal(body.render, null, "no provider video claimed");
  const pay = await getj("/api/odai/shop/payments");
  assert.equal(pay.body.revenue.collected_revenue, 0, "no spend or revenue invented");
});
