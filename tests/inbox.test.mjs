import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ingestEvent, listInbox, updateInbox } from "../server/odai/inbox.mjs";
import { get, logEvent } from "../server/odai/store.mjs";
process.env.AIVORA_MEMORY_MODE = "1";
test("HTTP dispatcher denies foreign tenants, persists reads and routes inbox intents", async () => {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, HOST: "127.0.0.1", PORT: "8337", AIVORA_MEMORY_MODE: "1" }, stdio: "ignore" });
  const base = "http://127.0.0.1:8337";
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await fetch(base + "/api/odai/inbox?tenant=foreign")).status, 403);
    const get = async () => (await fetch(base + "/api/odai/inbox")).json();
    const first = await get(); assert.equal(first.source, "local_disk");
    const intent = await fetch(base + "/api/odai/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Show me my inbox" }) });
    assert.equal((await intent.json()).inbox, true);
    const mark = await fetch(base + "/api/odai/inbox/all", { method: "POST", body: JSON.stringify({ action: "read_all" }) }); assert.equal(mark.status, 200);
    assert.equal((await get()).counts.unread, 0);
  } finally { child.kill(); }
});
const tenant = "inbox-test-" + randomUUID();
const event = { event_id: randomUUID(), ts: new Date().toISOString(), kind: "ROGUEAI_BLOCK", actor: "crm", decision: "BLOCK", note: "private@example.com +65 12345678 secret address <script>" };
test("event ingestion deduplicates and strips private payloads", () => {
  ingestEvent(tenant, event); ingestEvent(tenant, event);
  const j = listInbox(tenant); assert.equal(j.messages.length, 1); assert.equal(j.counts.security, 1); assert.equal(j.counts.unread, 1);
  assert.doesNotMatch(JSON.stringify(j), /private@example|12345678|secret address|<script>/);
});
test("disk refresh, search, category filters, reads and archive counts", async () => {
  const fresh = await import("../server/odai/inbox.mjs?refresh=" + randomUUID());
  assert.equal(fresh.listInbox(tenant).messages.length, 1);
  assert.equal(listInbox(tenant, { category: "INSIGHTS" }).messages.length, 0);
  assert.equal(listInbox(tenant, { q: "export" }).messages.length, 1);
  const id = listInbox(tenant).messages[0].notification_id;
  updateInbox(tenant, id, "read"); assert.equal(fresh.listInbox(tenant).counts.unread, 0);
  updateInbox(tenant, id, "archive"); assert.equal(listInbox(tenant).counts.security, 0);
});
test("tenant and user isolation; unsupported approvals fail closed", () => {
  assert.equal(listInbox(tenant + "other").messages.length, 0);
  assert.throws(() => listInbox(tenant, {}, "another-user"), /denied/);
  assert.throws(() => updateInbox(tenant, "missing", "approve"), /exact action/);
});
test("single actual logEvent stream populates inbox and priority summary", () => {
  const t = get(tenant); logEvent(t, { kind: "PURCHASE_RECORDED", actor: "crm", decision: "ALLOW" });
  logEvent(t, { kind: "ROGUEAI_BLOCK", actor: "crm", decision: "BLOCK" });
  const j = listInbox(tenant); assert.equal(j.messages.length, 2); assert.match(j.summary, /^Unauthorized export blocked/);
  updateInbox(tenant, null, "read_all"); assert.equal(listInbox(tenant).counts.unread, 0);
});
test("online persistence never falls through to local memory or disk", () => {
  process.env.AIVORA_MEMORY_MODE = "0";
  try { assert.throws(() => listInbox(tenant), /Online inbox blocked/); assert.throws(() => ingestEvent(tenant, event), /Online inbox blocked/); }
  finally { process.env.AIVORA_MEMORY_MODE = "1"; }
});
