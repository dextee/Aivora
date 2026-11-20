# F-1 Provenance Report — V36→V38 era (WO-01, DEV-01+DEV-12 audit)

Generated: 2026-11-20 · Page `app-1fe44043-4ed153f9` (aivora-odai-realtime) · HEAD at audit: `09d2122b90ed8a1cb50a6a2e4c1db1d7a3bc61c7` (deployed version V38)

Method: `git log -6`, then `git show --name-only` per commit. Classification per the WO-01 gate:
- **RUNTIME** = `src/`, `server.mjs` / `server/**.mjs`, `index.html`, `package.json`, `package-lock.json`, `vite.config.ts`
- **TOOLS/DOCS** = `tools/**`, `AGENTS.md`, `docs/**`, `odai/docs/**`, `odai/dev_docs/**`
- **TESTS** = `tests/**` (not runtime by definition; listed for completeness)

All six checkpoint commits carry the generic message `checkpoint: save QW Page source`; attribution therefore relies on file-level diffs, not messages.

## Classification table (last 6 commits)

| OID | Timestamp (+0800) | Files | Runtime files changed? | Explanation in AGENTS.md |
|---|---|---|---|---|
| `09d2122b` | 2026-11-20 17:17:01 | `AGENTS.md`, `tools/guardrails_preflight.mjs` | **NO** — tools/docs only | Yes: "Standing Guardrails (DEV-12)" section added with the tool |
| `e076db65` | 2026-11-20 14:06:49 | `AGENTS.md` | **NO** — docs only | Yes: V34 deploy note (chips "verified live … V36 deploy") |
| `72583567` | 2026-11-20 14:06:47 | `docs/objective-engine-demo-v33.txt` | **NO** — docs only | Yes: V33 demo transcript |
| `c777a2b8` | 2026-11-20 14:06:02 | `AGENTS.md` | **NO** — docs only | Yes: V33 verification section |
| `9b828eae` | 2026-11-20 14:05:16 | `AGENTS.md`; **RUNTIME**: `server/odai/objectives.mjs`, `src/TalkView.tsx`, `src/styles.css`; `tests/objectives.test.mjs` | **YES** | Yes — this is the **V34** increment, deployed as **V36** (AGENTS.md:132). Diffs verified line-by-line: `EXAMPLES`→`BIZ_INTENTS` ten owner-directed business-intent chips + sayExample intercepts; matching `.exrow/.exchip` grid CSS block; `objectives.mjs`/tests changes are purely one comment-delimiter and one whitespace fix (`connector_readiness`→`connector readiness` wording). No behaviour change in the engine module. |
| `ac7713a6` | 2026-11-20 13:53:06 | `odai/docs/objective-engine-demo-V32.txt` | **NO** — docs only | Yes: V32 demo transcript |

## V37/V38 mapping

- The last commit that touched any runtime file is `9b828eae` (14:05:16). Per AGENTS.md that source state was published as **V36**.
- Everything after it (`c777a2b8`, `72583567`, `e076db65`, `09d2122b`) changed ONLY `AGENTS.md`, `docs/**`, `odai/docs/**` and `tools/**` — i.e. the artifact versions **V37** and **V38** were built from trees containing **no runtime-file change** relative to V36-era source.

## Verdict

**RUNTIME-CLEAN.**

- No runtime file changed in the V37/V38 era at all — not even "what the pilot should have touched", because the pilot (a docs/guardrails-only increment window) should have touched no runtime file.
- Corollary, stated per the audit rule: **the pilot should not have published V37/V38 at all** — those versions carry zero runtime delta over V36; they were publishes of documentation-only snapshots.
- No unexplained `src/` diffs were found anywhere in the lookback window; the only `src/` changes belong to the documented V34→V36 increment.

Consequence: WO-02 is cleared to proceed (no owner-stop condition triggered).
