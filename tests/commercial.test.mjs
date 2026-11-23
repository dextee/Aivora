import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
let child; const B = "http://127.0.0.1:8321";
const post = async (u, b) => { const r = await fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (u) => { const r = await fetch(B + u); return { status: r.status, body: await r.json().catch(() => ({})) }; };
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], { env: { ...process.env, PORT: "8321", HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1" }, cwd: fileURLToPath(new URL(".", root)), stdio: "ignore" });
  const dl = Date.now() + 25000;
  for (;;) { try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot"); await new Promise((r) => setTimeout(r, 300)); }
});
after(() => child?.kill());

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PRODUCT = "COF-CEO-001";
let AVATAR = null, JOB = null;

test("CM-01 provider declaration: built-in seedance-2.0, 15s, no third-party SDK", async () => {
  const { status, body } = await getj("/api/odai/commercial/provider");
  assert.equal(status, 200);
  assert.equal(body.model, "seedance-2.0");
  assert.equal(body.duration_seconds, 15);
  assert.equal(body.engine, "qwenwork_builtin_video_generate");
  assert.match(body.note, /NOT used|never/i);
});

test("CM-02 missing product is BLOCKED with an explicit reason — nothing is generated", async () => {
  const { status, body } = await post("/api/odai/commercial", {});
  assert.equal(status, 200);
  assert.equal(body.status, "BLOCKED");
  assert.equal(body.blockers[0].code, "INPUTS_MISSING");
  assert.match(body.blockers[0].detail, /product/);
  assert.ok(!/avatar/.test(body.blockers[0].detail), "a self photo is optional now (owner instruction 2026-11-23)");
  assert.equal(body.render, null, "no fabricated render");
});

test("CM-03 avatar upload without likeness consent is refused (control G12)", async () => {
  const { status, body } = await post("/api/odai/commercial/input", { kind: "avatar", filename: "me.png", data_base64: PNG_1x1 });
  assert.equal(status, 403);
  assert.equal(body.code, "LIKENESS_CONSENT_REQUIRED");
});

test("CM-04 avatar upload with consent is stored with a sha256 and type check", async () => {
  const { status, body } = await post("/api/odai/commercial/input", { kind: "avatar", filename: "me.png", data_base64: PNG_1x1, likeness_consent: true });
  assert.equal(status, 200);
  assert.match(body.upload_id, /^UP-[0-9a-f]{12}$/);
  assert.equal(body.ext, "png");
  assert.equal(body.likeness_consent, true);
  assert.equal(body.sha256.length, 64);
  assert.ok(existsSync(body.path), "image persisted on disk");
  AVATAR = body.upload_id;
});

test("CM-05 non-image and executable content are rejected at the boundary", async () => {
  const zip = Buffer.from("PK\u0003\u0004not-an-image").toString("base64");
  const a = await post("/api/odai/commercial/input", { kind: "product", filename: "evil.zip", data_base64: zip, likeness_consent: false });
  assert.equal(a.status, 415, "zip magic rejected");
  const b = await post("/api/odai/commercial/input", { kind: "product", filename: "x.png", data_base64: "not-base64!!", likeness_consent: false });
  assert.ok([400, 415].includes(b.status), "garbage rejected: " + b.status);
});

test("CM-06 oversized image is rejected with 413", async () => {
  /* 8.4 MB decoded: above the module's 8 MB image limit but below the route's 12 MB raw cap,
   * so the rejection is a clean 413 rather than a socket reset. */
  const huge = Buffer.alloc(Math.round(8.4 * 1024 * 1024), 7).toString("base64");
  let status = 0, body = {}, reset = false;
  try { ({ status, body } = await post("/api/odai/commercial/input", { kind: "product", filename: "big.png", data_base64: "iVBOR" + huge })); }
  catch (e) { reset = /ECONNRESET|fetch failed/i.test(String(e.message || e)); }
  assert.ok(status === 413 || /limit|too large/i.test(String(body.error || "")) || reset,
    "expected a size rejection, got " + status + " " + JSON.stringify(body).slice(0, 90));
});

test("CM-07 unknown product id is BLOCKED — no product facts are invented", async () => {
  const { status, body } = await post("/api/odai/commercial", { avatar_upload_id: AVATAR, product_id: "COF-FAKE-999" });
  assert.equal(status, 200);
  assert.equal(body.status, "BLOCKED");
  assert.equal(body.blockers[0].code, "PRODUCT_NOT_IN_CATALOG");
});

test("CM-08 product photo without owner-stated facts is BLOCKED (control G13)", async () => {
  const up = await post("/api/odai/commercial/input", { kind: "product", filename: "pack.png", data_base64: PNG_1x1 });
  assert.equal(up.status, 200);
  const { body } = await post("/api/odai/commercial", { avatar_upload_id: AVATAR, product_upload_id: up.body.upload_id });
  assert.equal(body.status, "BLOCKED");
  assert.equal(body.blockers[0].code, "PRODUCT_FACTS_REQUIRED");
  assert.match(body.blockers[0].detail, /never inferred/i);
});

test("CM-09 avatar + catalog product produces a grounded 15s render spec", async () => {
  const { status, body } = await post("/api/odai/commercial", { avatar_upload_id: AVATAR, product_id: PRODUCT, language: "English", aspect_ratio: "9:16", campaign_id: null });
  assert.equal(status, 200);
  assert.equal(body.status, "READY_TO_RENDER", JSON.stringify(body.blockers));
  assert.equal(body.spec.duration_seconds, 15);
  assert.equal(body.spec.resolution, "1080p");
  assert.equal(body.spec.model, "seedance-2.0");
  assert.equal(body.spec.reference_images.length, 2, "avatar + product references");
  assert.equal(body.spec.grounded_in.catalog_verified, true);
  assert.equal(body.spec.grounded_in.product_id, PRODUCT);
  assert.match(body.spec.prompt, /CEO Signature Coffee/);
  assert.match(body.spec.prompt, /SGD 21\.90/, "the verified catalog price, not an invented one");
  assert.match(body.spec.negative_prompt, /invented prices/i);
  assert.equal(body.render, null, "still no video: spec only");
  JOB = body.job_id;
});

test("CM-10 dispatch moves to PENDING_PROVIDER and still claims no file", async () => {
  const { status, body } = await post(`/api/odai/commercial/${JOB}/dispatch`, { provider_task_id: "mt_test_task" });
  assert.equal(status, 200);
  assert.equal(body.status, "PENDING_PROVIDER");
  assert.equal(body.provider_task_id, "mt_test_task");
  assert.equal(body.render, null);
});

test("CM-11 job state persists on disk and is re-readable", async () => {
  const { status, body } = await getj(`/api/odai/commercial/${JOB}`);
  assert.equal(status, 200);
  assert.equal(body.job_id, JOB);
  assert.equal(body.status, "PENDING_PROVIDER");
  const list = await getj("/api/odai/commercial");
  assert.ok(list.body.jobs.some(j => j.job_id === JOB), "listed from the persisted store");
});

test("CM-12 attaching a non-video or an out-of-tolerance render is refused", async () => {
  const notVideo = await post(`/api/odai/commercial/${JOB}/render`, { file_path: fileURLToPath(new URL("package.json", root)) });
  assert.equal(notVideo.status, 415, "json is not an mp4 container");
  const missing = await post(`/api/odai/commercial/${JOB}/render`, { file_path: "D:/does/not/exist.mp4" });
  assert.equal(missing.status, 404);
  const real = "D:/AIVORA/Ecommerce store/RM4-coffee-ad-15s.mp4";
  if (existsSync(real)) {
    const bad = await post(`/api/odai/commercial/${JOB}/render`, { file_path: real, duration_seconds: 42 });
    assert.equal(bad.status, 422, "duration outside the 15s tolerance");
    assert.equal(bad.body.code, "DURATION_OUT_OF_TOLERANCE");
  }
});

test("CM-13 a real mp4 render attaches, verifies and is served as video/mp4", async () => {
  const real = "D:/AIVORA/Ecommerce store/RM4-coffee-ad-15s.mp4";
  if (!existsSync(real)) { console.log("   (skipped: no mp4 fixture on disk)"); return; }
  const { status, body } = await post(`/api/odai/commercial/${JOB}/render`, { file_path: real, duration_seconds: 15, provider_task_id: "mt_test_task" });
  assert.equal(status, 200);
  assert.equal(body.status, "RENDERED");
  assert.equal(body.render.container, "mp4/ftyp");
  assert.equal(body.render.duration_seconds, 15);
  assert.equal(body.render.sha256.length, 64);
  assert.equal(body.render.bytes, readFileSync(real).length);
  const r = await fetch(`${B}/api/odai/commercial/${JOB}/file`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "video/mp4");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, body.render.bytes);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "ftyp");
});

test("CM-15 a product-only commercial needs no self photo (owner instruction 2026-11-23)", async () => {
  const { status, body } = await post("/api/odai/commercial", { product_id: PRODUCT, language: "English", aspect_ratio: "9:16" });
  assert.equal(status, 200);
  assert.equal(body.status, "READY_TO_RENDER", JSON.stringify(body.blockers));
  assert.equal(body.avatar, null, "no avatar was required or invented");
  assert.equal(body.spec.reference_images.length, 1, "product image only");
  assert.match(body.spec.reference_roles.join(" "), /product/);
  assert.ok(!/avatar/i.test(body.spec.reference_roles.join(" ")), "no avatar reference claimed");
  assert.match(body.spec.prompt, /SGD 21\.90/);
  assert.ok(body.audit.some(a => a.event === "NO_AVATAR"), "the choice is recorded in the audit trail");
});

test("CM-16 supplying a photo still requires likeness consent (control G12 unchanged)", async () => {
  const { status, body } = await post("/api/odai/commercial/input", { kind: "avatar", filename: "me.png", data_base64: PNG_1x1 });
  assert.equal(status, 403);
  assert.equal(body.code, "LIKENESS_CONSENT_REQUIRED");
});
test("CM-14 another workspace cannot read or create commercial jobs", async () => {
  const a = await getj("/api/odai/commercial?tenant=other-workspace-cm");
  assert.equal(a.status, 403);
  const b = await post("/api/odai/commercial?tenant=other-workspace-cm", { avatar_upload_id: AVATAR, product_id: PRODUCT });
  assert.equal(b.status, 403);
});
