import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/* feat/composer-attachments — the local upload sink + honest model context. */

const root = new URL("../", import.meta.url);

async function openPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") throw new Error("Unable to allocate a test port");
  return address.port;
}

/* ---------- module unit (no server) ---------- */
const mod = () => import(new URL("server/uploads.mjs", root).href);

test("classify enforces the exact allowlist (media/docs/text ok, executables rejected)", async () => {
  const { classify } = await mod();
  assert.equal(classify("clip.mp4", "video/mp4"), "video");
  assert.equal(classify("song.mp3", "audio/mpeg"), "audio");
  assert.equal(classify("shot.PNG", "image/png"), "image");
  assert.equal(classify("anything", "image/webp"), "image");        // "all image types" via mime
  assert.equal(classify("paper.pdf", "application/pdf"), "pdf");
  assert.equal(classify("memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(classify("notes.txt", "text/plain"), "text");
  assert.equal(classify("readme.md", "text/markdown"), "text");
  assert.equal(classify("evil.exe", "application/x-msdownload"), null);
  assert.equal(classify("script.sh", "text/x-shellscript"), null);
});

test("storeUpload extracts real text for a .txt and marks it analyzable", async () => {
  const { storeUpload, getUploadMeta, contextForAttachments } = await mod();
  const data = Buffer.from("Revenue grew 24% quarter over quarter.").toString("base64");
  const r = storeUpload({ name: "summary.txt", mime: "text/plain", data });
  assert.equal(r.ok, true);
  assert.equal(r.meta.kind, "text");
  assert.equal(r.meta.analyzable, true);
  assert.ok(r.meta.text_chars > 0);
  const meta = getUploadMeta(r.meta.id);
  assert.equal(meta.text, "Revenue grew 24% quarter over quarter.");
  const ctx = contextForAttachments([r.meta.id]);
  assert.match(ctx, /summary\.txt/);
  assert.match(ctx, /Revenue grew 24%/);
});

test("storeUpload stores a PDF but honestly reports it as not analyzable", async () => {
  const { storeUpload, contextForAttachments } = await mod();
  const r = storeUpload({ name: "invoice.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4\n…").toString("base64") });
  assert.equal(r.ok, true);
  assert.equal(r.meta.kind, "pdf");
  assert.equal(r.meta.analyzable, false);
  const ctx = contextForAttachments([r.meta.id]);
  assert.match(ctx, /not readable by the text model/);
});

test("storeUpload rejects a disallowed type and an empty payload", async () => {
  const { storeUpload } = await mod();
  assert.equal(storeUpload({ name: "x.exe", mime: "application/x-msdownload", data: "AAAA" }).ok, false);
  assert.equal(storeUpload({ name: "x.exe", mime: "application/x-msdownload", data: "AAAA" }).status, 415);
  assert.equal(storeUpload({ name: "a.txt", mime: "text/plain", data: "" }).status, 400);
});

test("storeUpload rejects a file over the 25 MB cap", async () => {
  const { storeUpload, MAX_BYTES } = await mod();
  const oversize = Buffer.alloc(MAX_BYTES + 1).toString("base64");
  const r = storeUpload({ name: "huge.mp4", mime: "video/mp4", data: oversize });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

/* ---------- server integration (booted in memory mode, no key) ---------- */
let child = null;
let base = "";

before(async () => {
  const port = await openPort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
    cwd: fileURLToPath(new URL(".", root)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production", AIVORA_MEMORY_MODE: "1" },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become ready: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

after(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
});

test("POST /api/uploads stores a txt and GET /api/uploads/:id returns its metadata", async () => {
  const up = await fetch(`${base}/api/uploads?_t=${Date.now()}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "hello.txt", mime: "text/plain", data: Buffer.from("hello aivora").toString("base64") }),
  });
  assert.equal(up.status, 200);
  const { ok, file } = await up.json();
  assert.equal(ok, true);
  assert.equal(file.kind, "text");
  assert.equal(file.analyzable, true);

  const meta = await fetch(`${base}/api/uploads/${file.id}`);
  assert.equal(meta.status, 200);
  const m = await meta.json();
  assert.equal(m.file.id, file.id);
  assert.equal(m.file.name, "hello.txt");
  assert.ok(!JSON.stringify(m).includes("hello aivora"), "metadata response must not leak the file text");
});

test("GET /api/uploads/:id for an unknown id → 404", async () => {
  const res = await fetch(`${base}/api/uploads/does-not-exist`);
  assert.equal(res.status, 404);
});

test("POST /api/uploads with a disallowed type → 415 JSON error", async () => {
  const res = await fetch(`${base}/api/uploads?_t=${Date.now()}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "malware.exe", mime: "application/x-msdownload", data: "AAAA" }),
  });
  assert.equal(res.status, 415);
  const j = await res.json();
  assert.equal(typeof j.error, "string");
});

test("POST /api/odai/uploads/approve → 501 when Supabase not configured (offline)", async () => {
  const res = await fetch(`${base}/api/odai/uploads/approve?_t=${Date.now()}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload_id: "00000000-0000-0000-0000-000000000001" }),
  });
  assert.equal(res.status, 501);
  const j = await res.json();
  assert.equal(j.code, "SUPABASE_NOT_CONFIGURED");
});
