/**
 * Local environment file loader.
 *
 * Reads a gitignored `.env.local` (falling back to `.env`) from the repository root at
 * boot and populates process.env, so the app can pick up DASHSCOPE_API_KEY and friends
 * without them being typed into a shell every run.
 *
 * Rules this module enforces:
 *  - A real process.env value ALWAYS wins over any file value (explicit env beats file).
 *  - The first existing candidate file wins; later candidates are ignored.
 *  - Values are never logged, never returned, never written anywhere. Only variable
 *    NAMES are recorded, so /api/keyinfo can report provenance without leaking a key.
 *  - The candidate files are gitignored (`.env`, `.env.*` in .gitignore), so they cannot
 *    be committed or published by accident.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// new URL("../", ...) already resolves to the repository root; do NOT wrap it in dirname(),
// which would strip the trailing separator and climb one level too high.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CANDIDATES = [".env.local", ".env"];

/** @type {{ loaded_from: string|null, names: string[] }} */
export const envFileState = { loaded_from: null, names: [] };

export function parseEnvText(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

for (const candidate of CANDIDATES) {
  const path = join(ROOT, candidate);
  if (!existsSync(path)) continue;
  let entries;
  try {
    entries = parseEnvText(readFileSync(path, "utf8"));
  } catch {
    continue; // unreadable file must not stop the server
  }
  const applied = [];
  for (const [key, value] of entries) {
    if (value === "") continue; // empty placeholder in the file = not configured
    const existing = process.env[key];
    if (existing !== undefined && existing !== "") continue; // real env wins
    process.env[key] = value;
    applied.push(key);
  }
  envFileState.loaded_from = candidate;
  envFileState.names = applied;
  break;
}
