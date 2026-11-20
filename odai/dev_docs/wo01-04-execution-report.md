# WO-01 / WO-02 / WO-04 Execution Report — AIVORA governed dev factory

- Owner: Francis Teo · Approved 2026-11-20
- Page: `app-1fe44043-4ed153f9` (aivora-odai-realtime, dynamic, domain clupxd6g.qwenwork.page)
- Repo: `/mnt/pages/page-repo-1255a831-bc45-4ee3-a572-8ff3e587ad2a` — `prepare` + `open` succeeded on first attempt (no-window fallback not needed)
- Environment: Node v22.23.5 / npm 10.9.9
- Commit chain this run: `09d2122b` (entry HEAD) → `ab05ffa7` (WO-01) → `060d225b` (WO-02, built & published as V39) → `2959267d` (WO-04) → final docs checkpoint at FINISH.

## Rule compliance

- (A) Permitted paths only: touched `odai/dev_docs/**` (reports + evidence), `package.json`, `server/odai/objectives.mjs`, `tests/objectives.test.mjs`, `tools/guardrails_preflight.mjs` (executed only, unmodified), `tools/release_evidence.mjs`, `AGENTS.md` (append-only single lines per WO). `scripts/prepare-publish.mjs` NOT touched (outside permitted paths — see WO-02 note).
- (B) `git status --porcelain` before every checkpoint: WO-01 → only `odai/dev_docs/`; WO-02 → only `package.json`, `server/odai/objectives.mjs`, `tests/objectives.test.mjs`; WO-04 → only `odai/dev_docs/evidence/`, `tools/release_evidence.mjs`. No `src/` change anywhere in this run. No abort condition triggered.
- (C) Build + full suite green before any code-touching checkpoint — outputs below.
- (D) Exactly ONE staging publish (WO-02 → V39). No production publish. WO-04 is docs/evidence-only and was NOT published.
- No credentials or key values printed anywhere in this report, the evidence JSON, or commit contents.

## WO-01 — F-1 provenance audit (DEV-01 + DEV-12)

Method: `git log -6`, then `git show --name-only` + full diffs per commit; runtime vs tools/docs classification. Findings (detail in `f1-provenance-report.md`):

| OID | Files (class) |
|---|---|
| `09d2122b` | AGENTS.md, tools/guardrails_preflight.mjs — tools/docs |
| `e076db65` | AGENTS.md — docs |
| `72583567` | docs/objective-engine-demo-v33.txt — docs |
| `c777a2b8` | AGENTS.md — docs |
| `9b828eae` | RUNTIME: `server/odai/objectives.mjs`, `src/TalkView.tsx`, `src/styles.css`; tests; AGENTS.md — documented V34 increment, deployed as V36; diffs verified line-by-line, fully explained |
| `ac7713a6` | odai/docs/objective-engine-demo-V32.txt — docs |

**Verdict: RUNTIME-CLEAN.** No runtime file changed in the V37/V38 era. Stated per the audit rule: the pilot should not have published V37/V38 at all — those versions carry zero runtime delta over V36. No unexplained `src/` diffs → owner-stop condition NOT triggered → WO-02 cleared to proceed.

Checkpoint: `ab05ffa7` (managed message is fixed by tooling: "checkpoint: save QW Page source"; logical label WO-01).

## WO-02 — technical preflight enforcement (DEV-12)

Changes:
1. `package.json`: added `"precheck": "node tools/guardrails_preflight.mjs"`.
2. `server/odai/objectives.mjs` `approve()`: new `preflightBlock()` runs BEFORE `wf.decideSpend` via `spawnSync(process.execPath, ["tools/guardrails_preflight.mjs"], {cwd: repo root})` — root resolved from `process.cwd()` then module-ancestor (no credential material in the command; relative tool path only). Non-zero exit ⇒ `logEvent` GATE/`PREFLIGHT_FAILED` trace event + return `{outcome:'PREFLIGHT_BLOCKED', reason:<stderr tail 200>}`; the spend approval is popped so the objective stays `AWAITING_SPEND_APPROVAL` (mirrors the existing refuse path). Additive only: PUBLISH/COMMS gates remain `approved_held_EXTERNAL_NEVER` and resume remains blocked by 9.0 connector-readiness rules regardless of the preflight result — verified in the added test.
   Honest scope note: the publish artifact does not ship `tools/` (`scripts/prepare-publish.mjs` is outside this WO's permitted paths), so deployed runtimes find no tool and treat it as "not run" (no-op) rather than a false-positive G3 block. Enforcement is therefore active wherever the tool exists (repo/CI/test server). Flagged for owner: shipping `tools/` into the artifact would need a `scripts/` change under a future WO.
3. `tests/objectives.test.mjs`: 2 added cases — "preflight tool exits 0 in repo tree" and "approve still behaves normally when preflight passes (no bypass, no breakage)" (asserts spend gate resumes to REPORTED, fulfillment_sim simulated, publish gate held-NEVER).

Preflight stdout (repo tree):

    preflight clear: single-server ✓ provenance-inert ✓ lockfile ✓ single-policy ✓ editable-src ✓ test-gate ✓ single-dispatcher ✓

Fail-closed behaviour proven out-of-band against a simulated failing tool (temporary /tmp probe tree, since removed): `outcome=PREFLIGHT_BLOCKED`, `reason="PREFLIGHT FAIL:\n - simulated violation"`, state stayed `AWAITING_SPEND_APPROVAL`, `watch_verify=pending`.

Gate (C) — `npm run typecheck && npm test` (build included), TAP tail:

    1..16
    # tests 24
    # suites 3
    # pass 24
    # fail 0
    # cancelled 0
    # skipped 0
    # todo 0
    # duration_ms 16163.051499    # (final evidence re-run: 24/24, exit 0)

Checkpoint: `060d225b`. Publish (single, staging):

    Creating version V39... Sealing dynamic Artifact... Submitting V39...
    Deployment 305e4d13-e5a2-491c-a9df-0cc491e22b7b: queued → deployed
    runtime.zip 3801648 bytes, 711 files, sha256=9468e61f…d3a1cd · entrypoint server.mjs · port 8081 · --with-database (broker contract)

Post-deploy endpoint verification:

    /api/health     -> HTTP 200  {"status":"ok"}
    /api/odai/modes -> HTTP 200  {"contract":"ui_modes_9_0","policy_version":"1.0+R01-R19",…,"mode_change_grants_permission":false}
    / (root)        -> HTTP 200

## WO-04 — DEV-11 release evidence

New `tools/release_evidence.mjs` writes `odai/dev_docs/evidence/<version>.json` = `{at, commit_oid_head, dist[]{name,sha256}, npm_test{exit,tests,pass,fail,skipped,duration_ms,tap_tail} captured live from the TAP tail, page_version, notes}`; refuses to certify unless npm test is fully green.

Run for the just-published version: `node tools/release_evidence.mjs V39 "…deployment 305e4d13…"` output:

    wrote odai/dev_docs/evidence/V39.json · commit 060d225b · dist assets 5 · tests 24/24 pass, 0 fail

Evidence records HEAD `060d225bd6bb8963d93247ce66a98006db4005de` (the exact V39 source commit), 5 dist assets with sha256, and the real TAP summary. Docs-only change: NOT published (rule D does not allow a second publish). Checkpoint: `2959267d`.

## FINISH

- AGENTS.md: one line appended per WO (WO-01/WO-02/WO-04), append-only, in the same change set as the report.
- Task pause ("AIVORA WO-01..04 execution"): NOT performed — this run executes inside that scheduled task, and task execution rules prohibit any scheduled-task/automation mutation (including pausing it) from within an execution. The owner can pause it from their scheduler UI. Truthfully unavailable here, not silently skipped.
- Deliverables in-repo: `odai/dev_docs/f1-provenance-report.md`, `odai/dev_docs/evidence/V39.json`, `tools/release_evidence.mjs`, `odai/dev_docs/wo01-04-execution-report.md` (this file), AGENTS.md lines, WO-02 code/tests/package.json change.
