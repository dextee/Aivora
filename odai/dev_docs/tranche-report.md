# Tranche B Report — AIVORA Security & Recovery (WO-05, WO-06, WO-07 + prerequisite re-audit)

- Owner-approved brief 2026-11-20 · executed 2026-11-20 · Page `app-1fe44043-4ed153f9` (aivora-odai-realtime, dynamic, clupxd6g.qwenwork.page)
- Repo: `/mnt/pages/page-repo-1255a831-bc45-4ee3-a572-8ff3e587ad2a` · entry HEAD `9538a972` (prepare+open succeeded first attempt; no retry needed)
- NO PUBLISHING occurred in this tranche. NO production touch.

## 1. STEP-0 prerequisite gate — PASS (all four checks)
| # | Check | Result |
|---|---|---|
| a | F-1 verdict in `f1-provenance-report.md` | **RUNTIME-CLEAN** (WO-01 audit; V37/V38 zero runtime delta; no unexplained src/ diffs) |
| b | Evidence JSON for latest version | `odai/dev_docs/evidence/V39.json` present; V39 = last published version (deployment 305e4d13); records certifying commit `060d225b…` |
| c | `node tools/guardrails_preflight.mjs` | exit **0** (all seven gates ✓) |
| d | `npm run build && npm test` | exit **0** — TAP 24 tests / 24 pass / 0 fail (pre-tranche baseline) |

Reads performed first: `AGENTS.md`, `odai/dev_docs/f1-provenance-report.md`, `odai/dev_docs/evidence/V39.json`, `odai/dev_docs/wo01-04-execution-report.md`.

## 2. WO-07 — backup infrastructure · commit `d2279dda`
- Artifacts (OUTSIDE repo at `/tmp/tranche-backup/`; brief's `/tranche-backup` impossible — sandbox `/` is read-only):
  - `aivora-source-complete.tar.gz` 426,298 B / 55 files (repo minus node_modules, dist, .qw-pages, .git; verified identical to tracked-file set)
  - `aivora-git-history.bundle` 505,967 B — complete history, HEAD `9538a972`
  - `manifest.sha256` — tar `bb1ce4981cc72f0a…8bfa9c`, bundle `e59079a57120d8b9…a15004`
- Secret exclusion audit: file-list grep + full streamed-content grep (`.env|key|secret|sk-|bearer|token|credential|pem` + in-file secret regexes) → **0 hits in both artifacts**; `git bundle verify` okay (refs listed above).
- Agent registry snapshot: **not applicable** — `odai/dev_docs/agents-snapshot` absent AND no `.qwenwork/agents/*.md` exists anywhere reachable in this sandbox (checked workspace and home `.qwenwork/` trees). Recorded honestly; nothing fabricated.
- Isolated restoration test (`/tmp/wo07-restore-1795171149`): extract ✓ · clone bundle ✓ · clone HEAD == repo HEAD ✓ · `sha256sum -c` both OK ✓ · `node --check server.mjs` ✓ · preflight on restored tree exit 0 ✓.
- Delivery: uploaded to Drive `/backups/tranche-B/` and share links created (active):
  - tar — https://share.qwenworkusercontent.com/share/drive/0032c25e-630b-42d0-95f1-bf8f189e2e38
  - bundle — https://share.qwenworkusercontent.com/share/drive/643ced36-daf5-44e9-9c81-0f5a245ec956
  - manifest — https://share.qwenworkusercontent.com/share/drive/19fa01de-301d-47ed-957f-453b9d8b76ee
  - Account is an organization account → share pages are org-visible per platform policy.
- Full evidence: `odai/dev_docs/wo07-backup-report.md`.
- Aging note: the WO-05/WO-06 commits below post-date the backup snapshot (inherent to doing backups first, per the brief's own ordering). The bundle always replays full history; a refreshed bundle can be produced on request.

## 3. WO-05 — deterministic guardrails · commit `3dcee0d6`
- `tools/guardrail_harness.mjs` (exit contract: 0 OK · 1 preflight-violation propagated · 2 fail-closed · 3 unauthorized path · 4 self-modification refusal · 5 usage) + `tests/guardrails-harness.test.mjs` (8 tests), both **branch-local — zero runtime imports** (proved by Drill F, which also scans `server/**`, `src/**`, `server.mjs` for any reference to the harness).
- Drills, all asserting exit codes: **A** duplicate policy-evaluator copy on scratch tree → preflight fails (exit 1); **B** provenance/evidence import injected into scratch `server.mjs` → G5 fires (exit 1); **C** preflight tool itself deleted → harness FAIL-CLOSED (exit 2); **D** `enforce_allowlist(changed_files, WO_scope)` simulation → non-zero (exit 3) on `src/…`, `index.html`, `package.json` for security-class WOs, scoped paths pass (exit 0), empty list fails closed, scope-forgery (frozen alias in targets) rejected; **E** agent-self-modification → harness refuses (exit 4) when its own file is in the changed set with `role != DEV-08-ordered-work-order`, and only a parsed ordered fixture WO (targeting every self-file) passes.
- Suite after wiring: `npm test` 32/32 green, preflight exit 0.
- ⚑ Owner-escalation note: the brief both (i) requires the new test file "added to npm test script list" and (ii) says keep `package.json` outside security-WO commits. The only implementation of (i) is a `package.json` **test-script-list** edit, so that single field was changed in the WO-05/WO-06 commits; no dependency, build, start, or precheck field was touched, and `src/` + `index.html` remain untouched exactly as ordered. Drill D's parenthetical is read as "drills must SIMULATE — never actually mutate those files", which was honored.

## 4. WO-06 — AI watching AI · commit `6437e955`
- `tools/watchd.mjs` + `tests/watchd.test.mjs` (5 tests; wired into npm test; harness SELF_FILES extended to include `tools/watchd.mjs`, i.e. WO-06 ran under Drill-E ordering).
- Reads: last n rows of `odai_trace` + `odai_receipt` via the page **DATABASE control path** (`POST /api/page/<domain>/database/query`, MULE token, SELECT-only enforced twice: regex gate in code + the endpoint itself accepts only SELECT). Token travels only in a 0600 curl-config file, never argv/logs/incidents. Redacted view = `kind/beat/actor/decision/rule/note≤120` only (unit-tested incl. leak columns).
- Detectors: S1 decision≠ALLOW on dispatch · S2 TASK_FAILED (literal + GATE/PREFLIGHT_FAILED) · S3 gate-state flips without APPROVAL_GRANTED lineage (DECLINED ≠ lineage, tested) · S4 unknown-scope approvals (forged-scope heuristics per F-1) · S5 duplicate-beat receipt anomaly.
- HARD RULE proven: incident schema frozen `containment-request/v1` (`requested_action`, `actor:"DEV-13"`, `state_written_by_this_module:"none"`); `requestSelfApproval()` always returns `ok:false` / `SELF_APPROVAL_REJECTED` for any actor==self-approve attempt; a write-guard throws on any approval-shaped payload BEFORE writing; zero-signals → no file (valid finding).
- Live sample run (window 40): 40 trace + 40 receipt rows read → **7 signals, one incident file** `odai/dev_docs/watch/incidents/20261120T105241Z.json` — all `DISPATCH_NON_ALLOW`, all matching governed TEST behaviour (beat-7 NEVER watch-blocks by design; beat-5 `APPROVE` = "spend cap offered, awaiting owner confirmation" pre-gate records). **Zero** TASK_FAILED / lineage / forged-scope / duplicate-receipt findings in the window. Owner may wish to whitelist known TEST decision vocabularies or leave them surfaced.

## 5. Totals & standing
- Commits this tranche: **4 content commits** — `d2279dda` (WO-07) · `3dcee0d6` (WO-05) · `6437e955` (WO-06) · `d307bdca` (tranche docs + AGENTS.md), plus one closeout docs fixup for this pause note. Physical commit messages are the platform checkpoint text; logical labels are recorded here.
- **0 publishes · 0 production touches · no new scheduled tasks/automations created.** Broader autonomy NOT enabled: nothing in this tranche grants any agent publish, external-write, or self-approval authority; WO-06 can only REQUEST containment.
- The **four queued competition UI work orders remain UNTOUCHED** in the owner-side backlog (this tranche touched no `src/`, `index.html`, or UI surfaces at all).
- Task pause: the brief's closing instruction was to set this scheduled task to `paused`. The task "AIVORA security recovery tranche" is identified (currently `active`), but pausing was **NOT performed**: this run executes inside that very task, and platform task-execution rules forbid any scheduled-task mutation (including pausing the running task, directly or via scripts) from within an execution. Truthfully unavailable here, not silently skipped — the owner must pause it from the scheduler UI (same outcome as the WO-01..04 tranche, recorded in `wo01-04-execution-report.md`).
