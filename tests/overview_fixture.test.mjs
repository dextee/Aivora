import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the overview replays the local engine's sample plan and held approval gates", async (t) => {
  process.env.AIVORA_MEMORY_MODE = "1";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Overview fixture must not call an external service"); });
  const { createObjective } = await import("../server/odai/objectives.mjs");
  const sample = JSON.parse(await readFile(new URL("../src/hackathon-demo.json", import.meta.url), "utf8"));

  const result = await createObjective("aivora-overview-fixture", sample.statement);
  assert.equal(result.state, sample.state);
  assert.deepEqual(result.criterion, sample.criterion);
  assert.deepEqual(result.tasks.map(({ id, state, specialist }) => ({ id, state, specialist })), sample.tasks);
  assert.deepEqual(result.gates.map(({ id, scope, state }) => ({ id, scope, state })), sample.gates);
  assert.ok(result.gates.every(({ state }) => state === "awaiting_owner"));
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
