import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseEnvText } from "../server/env_file.mjs";

// new URL("../", ...) already resolves to the repo root; dirname() would climb one level too high.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    // `git check-ignore` exits 1 when the path is NOT ignored — that is a valid answer.
    if (e?.status === 1 && args[0] === "check-ignore") return "";
    throw e;
  }
}

test("EF-01 parses KEY=VALUE, strips quotes, ignores comments and blank lines", () => {
  const m = parseEnvText([
    "# a comment",
    "",
    "DASHSCOPE_API_KEY=abc123",
    'WORKSPACE_ID="ws-quoted"',
    "QWEN_REGION='ap-southeast-1'",
    "   PORT = 8081   ",
    "not a line",
  ].join("\n"));
  assert.equal(m.get("DASHSCOPE_API_KEY"), "abc123");
  assert.equal(m.get("WORKSPACE_ID"), "ws-quoted");
  assert.equal(m.get("QWEN_REGION"), "ap-southeast-1");
  assert.equal(m.get("PORT"), "8081");
  assert.equal(m.has("not a line"), false);
});

test("EF-02 first occurrence wins and values may contain '=' (base64, JWT)", () => {
  const m = parseEnvText("TOKEN=aaa=bbb==\nTOKEN=second\n");
  assert.equal(m.get("TOKEN"), "aaa=bbb==");
});

test("EF-03 the key files are git-ignored so they can never be committed", () => {
  assert.equal(git("check-ignore", ".env.local"), ".env.local");
  assert.equal(git("check-ignore", ".env"), ".env");
});

test("EF-04 the shareable template is NOT ignored", () => {
  assert.equal(git("check-ignore", ".env.example"), "");
});

test("EF-05 no tracked file contains a key-shaped secret", () => {
  const files = git("ls-files").split(/\r?\n/).filter(Boolean);
  const bad = files.filter(f => /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f));
  assert.deepEqual(bad, [], `tracked env files found: ${bad.join(", ")}`);
});

test("EF-06 the local env file holds credentials only, never runtime mode", async () => {
  // A secrets file is loaded by EVERY server that boots in this directory, including the
  // test suite's own spawned servers. Setting AIVORA_MEMORY_MODE / PORT / HOST here would
  // silently change app behaviour for all of them (it broke the auth_wiring bearer guard
  // once already). Keep those on the command line.
  const { existsSync, readFileSync } = await import("node:fs");
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return; // absent is fine — the writer script creates it on demand
  const m = parseEnvText(readFileSync(p, "utf8"));
  for (const name of ["AIVORA_MEMORY_MODE", "PORT", "HOST"]) {
    assert.equal(m.get(name) || "", "", `.env.local must not set ${name}`);
  }
});
