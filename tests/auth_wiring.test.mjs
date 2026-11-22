import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/* feat: Supabase Auth wiring — client-safe config endpoint + bearer-required guard.
 * The "configured" server uses DUMMY SUPABASE_* env (no real Supabase needed): the guard
 * rejects before any DB call, so it is fully testable offline. */

const root = new URL("../", import.meta.url);

async function openPort() {
  const l = createServer();
  await new Promise((res, rej) => { l.once("error", rej); l.listen(0, "127.0.0.1", res); });
  const a = l.address();
  await new Promise((res, rej) => { l.close((e) => (e ? rej(e) : res())); });
  if (!a || typeof a === "string") throw new Error("no port");
  return a.port;
}

async function boot(env) {
  const port = await openPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
    cwd: fileURLToPath(new URL(".", root)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production", ...env },
    stdio: "pipe",
  });
  let stderr = ""; child.stderr.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`no boot: ${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base };
}

let offline = null, configured = null;
const DUMMY_URL = "http://127.0.0.1:54321";
const DUMMY_KEY = "sb_publishable_DUMMYTESTKEY000000";

before(async () => {
  offline = await boot({ AIVORA_MEMORY_MODE: "1" });
  configured = await boot({ SUPABASE_URL: DUMMY_URL, SUPABASE_PUBLISHABLE_KEY: DUMMY_KEY, SUPABASE_INSTANCE_ID: "dummy-instance" });
});
after(() => {
  for (const s of [offline, configured]) if (s && s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGTERM");
});

test("offline mode: /api/config/supabase reports not configured", async () => {
  const r = await fetch(`${offline.base}/api/config/supabase`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { configured: false });
});

test("offline mode: ODAI routes stay open (demo unchanged)", async () => {
  const r = await fetch(`${offline.base}/api/odai/modes`);
  assert.equal(r.status, 200);
});

test("configured mode: /api/config/supabase exposes only the client-safe config", async () => {
  const r = await fetch(`${configured.base}/api/config/supabase`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.configured, true);
  assert.equal(j.url, DUMMY_URL);
  assert.equal(j.publishableKey, DUMMY_KEY);
  assert.ok(!("serviceRoleKey" in j), "must never expose the service key");
});

test("configured mode: ODAI request with no bearer is rejected AUTH_REQUIRED (401)", async () => {
  const r = await fetch(`${configured.base}/api/odai/modes`);
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.code, "AUTH_REQUIRED");
});

test("configured mode: /api/health stays open (no auth needed for liveness)", async () => {
  const r = await fetch(`${configured.base}/api/health`);
  assert.equal(r.status, 200);
});
