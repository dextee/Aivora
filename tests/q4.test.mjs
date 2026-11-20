import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/* V31 — Qwen4-Max text-brain wiring: parseDelta units + keyless /api/q4/chat behaviour. */

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

/* ---------- parseDelta (unit) ---------- */
test("parseDelta concatenates text from native data: frames", async () => {
  const { parseDelta } = await import(new URL("server/qwen4.mjs", root).href);
  const frag =
    "id:1\n" +
    "event:result\n" +
    ':HTTP_STATUS/200\n' +
    'data: {"output":{"choices":[{"finish_reason":"null","message":{"content":[{"text":"hi"}],"role":"assistant"}}]},"usage":{"input_tokens":11,"output_tokens":1},"request_id":"8f2c1d7e-0a4b-9c3d-ef12-34567890abcd"}\n' +
    "\n" +
    "id:2\n" +
    "event:result\n" +
    ':HTTP_STATUS/200\n' +
    'data: {"output":{"choices":[{"finish_reason":"stop","message":{"content":[],"role":"assistant"}}]},"usage":{"input_tokens":11,"output_tokens":2},"request_id":"8f2c1d7e-0a4b-9c3d-ef12-34567890abcd"}\n' +
    "\n";
  assert.equal(await parseDelta(frag), "hi");
});

test("parseDelta returns empty string for malformed or non-native input", async () => {
  const { parseDelta } = await import(new URL("server/qwen4.mjs", root).href);
  assert.equal(await parseDelta("data: {oops not json\n\n: just a comment\ndata: 42\n"), "");
  assert.equal(await parseDelta("plain text, no frames at all"), "");
  assert.equal(await parseDelta(""), "");
  assert.equal(await parseDelta(null), "");
  assert.equal(await parseDelta('data: {"code":"InvalidParameter","message":"model not found"}'), "");
});

/* ---------- server integration (booted WITHOUT supabase/dashscope env) ---------- */
let child = null;
let base = "";

before(async () => {
  const port = await openPort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [new URL("server.mjs", root).pathname], {
    cwd: new URL(".", root).pathname,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production" },
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

test("POST /api/q4/chat with no key available → 503 JSON error mentioning the key", async () => {
  const res = await fetch(`${base}/api/q4/chat?_t=${Date.now()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(res.status, 503);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const j = await res.json();
  assert.equal(typeof j.error, "string");
  assert.match(j.error, /key/i);
  assert.ok(!j.error.includes("sk-"), "error body must not look like a key");
});

test("GET /api/health stays credential-free 200 ok", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});
