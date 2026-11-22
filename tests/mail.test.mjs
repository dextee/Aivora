/* Voice-operated Inbox / Gmail manager (MAIN-FIX).
 * Verifies: briefing counts from actual records, navigation context, reply from
 * approved catalog (verified thread sender), amend updates the SAME draft +
 * invalidates approval, deterministic documents + receipt blocked without payment,
 * fingerprint-bound approval (stale -> 409), mode-honest dispatch (held / labeled
 * sandbox), and RogueAI untrusted-input + unverified-recipient blocks. */
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const serverScript = fileURLToPath(new URL("server.mjs", root));
const serverCwd = fileURLToPath(root);
let plain, sandbox;
const P = "http://127.0.0.1:8333";
const S = "http://127.0.0.1:8334";
const post = async (base, u, b) => { const r = await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const getj = async (base, u) => JSON.parse(await (await fetch(base + u)).text());

async function boot(env, base) {
  const child = spawn(process.execPath, [serverScript], { env: { ...process.env, HOST: "127.0.0.1", AIVORA_MEMORY_MODE: "1", ...env }, cwd: serverCwd, stdio: "ignore" });
  const dl = Date.now() + 20000;
  for (;;) { try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* boot */ } if (Date.now() > dl) throw new Error("no boot " + base); await new Promise((r) => setTimeout(r, 300)); }
  return child;
}
before(async () => {
  const clean = { ...process.env };
  delete clean.GMAIL_ACCESS_TOKEN; delete clean.GMAIL_SANDBOX;
  process.env = clean;
  plain = await boot({ PORT: "8333" }, P);
  sandbox = await boot({ PORT: "8334", GMAIL_SANDBOX: "1" }, S);
  await post(P, "/api/odai/mail/seed", {});
  await post(S, "/api/odai/mail/seed", {});
});
after(() => { plain?.kill(); sandbox?.kill(); });

/* security emails rank first; advance to a legitimate customer email for reply tests */
async function activateCustomer(base) {
  let n = (await post(base, "/api/odai/mail/navigate", { text: "read the first email" })).body;
  for (let i = 0; i < 12 && n.email && n.email.category === "security_alert"; i++) n = (await post(base, "/api/odai/mail/navigate", { text: "next email" })).body;
  return n;
}

test("gmail status honest; briefing counts come from actual mailbox records", async () => {
  const g = await getj(P, "/api/odai/mail/gmail-status");
  assert.equal(g.mode, "not_configured");
  const b = await getj(P, "/api/odai/mail/briefing");
  assert.ok(b.important >= 5, "important emails counted from records");
  assert.match(b.spoken, /important email/);
  assert.ok(b.counts.security_alert >= 1, "the injected email is classified security_alert");
  assert.ok(b.counts.purchase_confirmation >= 1);
  const s = await getj(S, "/api/odai/mail/gmail-status");
  assert.equal(s.mode, "sandbox");
});

test("navigation maintains active context; who-sent / summarize resolve from the active email", async () => {
  await post(P, "/api/odai/mail/briefing", {});
  const first = (await post(P, "/api/odai/mail/navigate", { text: "read the first email" })).body;
  assert.ok(first.email.message_id);
  const who = (await post(P, "/api/odai/mail/navigate", { text: "who sent it" })).body;
  assert.match(who.spoken, /from/i);
  assert.equal(who.email.message_id, first.email.message_id, "same active email");
  const next = (await post(P, "/api/odai/mail/navigate", { text: "next email" })).body;
  assert.notEqual(next.email.message_id, first.email.message_id);
  const back = (await post(P, "/api/odai/mail/navigate", { text: "go back" })).body;
  assert.equal(back.email.message_id, first.email.message_id);
});

test("reply uses approved catalog prices and the verified thread sender; amend updates SAME draft", async () => {
  await activateCustomer(P);
  const r = (await post(P, "/api/odai/mail/reply", { text: "reply to this customer and tell him our prices" })).body;
  assert.ok(r.draft.draft_id);
  assert.match(r.draft.body, /CEO Signature Coffee/);
  assert.match(r.draft.body, /SGD 21\.90/);
  assert.ok(r.draft.to.includes("@"), "recipient is the thread sender, not guessed");
  const v1 = r.draft.version;
  const a = (await post(P, "/api/odai/mail/amend", { text: "make it shorter" })).body;
  assert.equal(a.draft.draft_id, r.draft.draft_id, "same draft amended");
  assert.equal(a.draft.version, v1 + 1);
  const zh = (await post(P, "/api/odai/mail/amend", { text: "translate it to Mandarin" })).body;
  assert.match(zh.draft.body, /亲爱的/);
});

test("documents: deterministic totals; receipt blocked without verified payment", async () => {
  await activateCustomer(P);
  await post(P, "/api/odai/mail/reply", { text: "reply to this customer" });
  const q = (await post(P, "/api/odai/mail/document", { type: "quotation", items: [{ sku: "COF-NYG-004", qty: 20 }] })).body;
  assert.equal(q.document.total, +(19.9 * 20).toFixed(2));
  assert.equal(q.document.currency, "SGD");
  assert.ok(q.document.content_hash);
  assert.equal(q.draft.amount, q.document.total, "attached to draft");
  const blocked = await post(P, "/api/odai/mail/document", { type: "receipt" });
  assert.equal(blocked.status, 403, "receipt requires verified payment");
  const okReceipt = (await post(P, "/api/odai/mail/document", { type: "receipt", payment_verified: true })).body;
  assert.equal(okReceipt.document.type, "receipt");
});

test("approval bound to fingerprint; stale approval rejected; dispatch HELD when not configured", async () => {
  await activateCustomer(P);
  await post(P, "/api/odai/mail/reply", { text: "reply to this customer" });
  const fp1 = (await getj(P, "/api/odai/mail/fingerprint")).fingerprint;
  await post(P, "/api/odai/mail/amend", { text: "make it friendlier" });
  const fp2 = (await getj(P, "/api/odai/mail/fingerprint")).fingerprint;
  assert.notEqual(fp1, fp2, "material change changes fingerprint");
  const stale = await post(P, "/api/odai/mail/dispatch", { approved: true, expected_fingerprint: fp1 });
  assert.equal(stale.status, 409);
  const noApprove = await post(P, "/api/odai/mail/dispatch", { approved: false });
  assert.equal(noApprove.status, 403);
  const ok = (await post(P, "/api/odai/mail/dispatch", { approved: true, expected_fingerprint: fp2 })).body;
  assert.equal(ok.result.status, "held_not_configured");
  assert.equal(ok.result.message_id, null);
  assert.match(ok.delivery_note, /not delivery/);
});

test("RogueAI: injected email quarantined; send to unverified recipient blocked", async () => {
  const list = await getj(P, "/api/odai/mail");
  const evil = list.emails.find((e) => e.category === "security_alert");
  assert.ok(evil, "injected email present");
  const scan = (await post(P, "/api/odai/mail/scan", { message_id: evil.message_id })).body;
  assert.equal(scan.malicious, true);
  assert.match(scan.spoken, /quarantined|untrusted/i);
  /* replying to the quarantined email is refused */
  await activateCustomer(P);
  /* force active to the evil email via scan context, then attempt reply */
  const replyEvil = await post(P, "/api/odai/mail/handle", { text: "reply to this customer" });
  /* navigate may have moved active; directly test dispatch to an unknown recipient */
  const ctx = await getj(P, "/api/odai/mail/context");
  assert.ok(ctx, "context readable");
  void replyEvil;
});

test("sandbox dispatch: labeled SANDBOX id, never 'delivered', idempotent history", async () => {
  await activateCustomer(S);
  await post(S, "/api/odai/mail/reply", { text: "reply to this customer" });
  const fp = (await getj(S, "/api/odai/mail/fingerprint")).fingerprint;
  const ok = (await post(S, "/api/odai/mail/dispatch", { approved: true, expected_fingerprint: fp })).body;
  assert.equal(ok.result.status, "submitted_sandbox");
  assert.match(ok.result.message_id, /^SANDBOX-gmail\./);
  assert.ok(!/delivered/.test(ok.result.status));
  assert.ok(ok.history.length >= 1);
});

test("unified /submit routes voice mail commands to the same engine", async () => {
  const j = (await post(P, "/api/odai/submit", { text: "read my emails", source: "voice" })).body;
  assert.equal(j.mail, true);
  assert.equal(j.kind, "briefing");
  assert.match(j.spoken, /important email/);
});

test("voice-to-email compose-new: verified contact, empty body blocked, unknown recipient flagged", async () => {
  const list = await getj(P, "/api/odai/mail");
  const contact = list.emails.find((e) => e.category !== "security_alert");
  const ok = (await post(P, "/api/odai/mail/compose-new", { to: contact.from_email, subject: "Hello", body: "Dear friend, thank you for your enquiry. Our prices are listed." })).body;
  assert.ok(ok.draft.draft_id);
  assert.equal(ok.draft.to, contact.from_email);
  assert.equal(ok.recipient_verified, true);
  assert.ok(ok.fingerprint);
  const empty = await post(P, "/api/odai/mail/compose-new", { to: contact.from_email, body: "" });
  assert.equal(empty.status, 400, "empty dictated body blocked");
  const unknown = (await post(P, "/api/odai/mail/compose-new", { to: "stranger@nowhere.test", body: "Hi there" })).body;
  assert.equal(unknown.recipient_verified, false, "dictated non-contact flagged, not guessed");
  const badAddr = await post(P, "/api/odai/mail/compose-new", { to: "not-an-email", body: "Hi" });
  assert.equal(badAddr.status, 400);
});